-- A learner's phone is normalized at the trusted Next.js boundary with
-- libphonenumber-js. This service-only RPC accepts only that normalized result
-- and atomically moves the account into the manual-review workflow. Browser
-- roles must never call it directly, otherwise they could pair an arbitrary
-- ISO country with a merely E.164-shaped number.

create function public.submit_profile_for_approval_from_trusted_server(
  p_user_id uuid,
  p_name text,
  p_surname text,
  p_job text,
  p_organization text,
  p_phone_country_iso2 text,
  p_phone_e164 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := private.normalize_profile_text(p_name);
  v_surname text := private.normalize_profile_text(p_surname);
  v_job text := private.normalize_profile_text(p_job);
  v_organization text := private.normalize_profile_text(p_organization);
  v_phone_country_iso2 text := upper(btrim(coalesce(p_phone_country_iso2, '')));
  v_phone_e164 text := btrim(coalesce(p_phone_e164, ''));
  v_profile public.profiles%rowtype;
  v_previous_profile public.profiles%rowtype;
  v_control public.account_controls%rowtype;
  v_is_admin boolean := false;
  v_same_profile boolean;
  v_requested_at timestamptz;
  v_due_at timestamptz;
  v_next_state public.account_approval_state;
  v_action text;
begin
  begin
    if p_user_id is null then
      raise exception using errcode = 'check_violation', message = 'PROFILE_USER_REQUIRED';
    end if;
    if char_length(v_name) not between 1 and 80
      or char_length(v_surname) not between 1 and 80
      or char_length(v_job) not between 1 and 160
      or char_length(v_organization) not between 1 and 160
      or v_name ~ '[[:cntrl:]]' or v_surname ~ '[[:cntrl:]]'
      or v_job ~ '[[:cntrl:]]' or v_organization ~ '[[:cntrl:]]' then
      raise exception using errcode = 'check_violation', message = 'PROFILE_FIELDS_REQUIRED';
    end if;
    if v_phone_country_iso2 !~ '^[A-Z]{2}$'
      or v_phone_e164 !~ '^\+[1-9][0-9]{1,14}$' then
      raise exception using errcode = 'check_violation', message = 'PROFILE_PHONE_INVALID';
    end if;

    select profile.* into v_profile
    from public.profiles profile
    where profile.id = p_user_id
    for update;
    if not found then
      raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
    end if;

    select control.* into v_control
    from public.account_controls control
    where control.user_id = p_user_id
    for update;
    if not found
      or v_control.status <> 'active'
      or v_control.deletion_pending
      or not exists (
        select 1
        from auth.users auth_user
        where auth_user.id = p_user_id
          and auth_user.deleted_at is null
          and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
      ) then
      raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
    end if;

    if not exists (
      select 1
      from private.profile_avatar_manifests manifest
      where manifest.user_id = p_user_id
        and v_profile.avatar_updated_at is not null
        and (
          (
            not manifest.legacy_imported
            and manifest.object_key =
              p_user_id::text || '/objects/' || manifest.operation_token::text || '.webp'
          )
          or (
            manifest.legacy_imported
            and manifest.object_key = p_user_id::text || '/avatar.webp'
          )
        )
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state', message = 'AVATAR_REQUIRED';
    end if;
    if not private.has_current_legal_acceptance(p_user_id) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'LEGAL_ACCEPTANCE_REQUIRED';
    end if;

    v_previous_profile := v_profile;

    update public.profiles
    set name = v_name,
        surname = v_surname,
        job = v_job,
        organization = v_organization,
        phone_country_iso2 = v_phone_country_iso2,
        phone_e164 = v_phone_e164,
        onboarding_completed_at = coalesce(onboarding_completed_at, statement_timestamp())
    where id = p_user_id
    returning * into v_profile;

    -- `profiles_attach_organization` may map aliases or casing to one
    -- canonical organization. Compare the locked old row with the post-trigger
    -- row so a semantically identical resubmit neither resets the 24-hour SLA
    -- nor creates noisy audit records.
    v_same_profile :=
      v_previous_profile.name is not distinct from v_profile.name
      and v_previous_profile.surname is not distinct from v_profile.surname
      and v_previous_profile.job is not distinct from v_profile.job
      and v_previous_profile.organization is not distinct from v_profile.organization
      and v_previous_profile.phone_country_iso2 is not distinct from v_profile.phone_country_iso2
      and v_previous_profile.phone_e164 is not distinct from v_profile.phone_e164;

    select coalesce(user_role.product_role = 'admin', false)
      into v_is_admin
    from public.user_roles user_role
    where user_role.user_id = p_user_id;

    -- Admins manage review; they are not placed into their own learner queue.
    if v_is_admin then
      update public.account_controls
      set approval_state = 'approved',
          approval_requested_at = null,
          approval_due_at = null,
          approval_decided_at = null,
          approval_decided_by = null,
          approval_rejection_reason = null
      where user_id = p_user_id;
      return private.ensure_rpc_payload(jsonb_build_object(
        'completed', true,
        'approvalState', 'approved',
        'approvalRequestedAt', null,
        'approvalDueAt', null
      ));
    end if;

    if v_control.approval_state = 'approved' and v_same_profile then
      return private.ensure_rpc_payload(jsonb_build_object(
        'completed', true,
        'approvalState', v_control.approval_state,
        'approvalRequestedAt', v_control.approval_requested_at,
        'approvalDueAt', v_control.approval_due_at
      ));
    end if;
    if v_control.approval_state = 'pending' and v_same_profile then
      return private.ensure_rpc_payload(jsonb_build_object(
        'completed', true,
        'approvalState', v_control.approval_state,
        'approvalRequestedAt', v_control.approval_requested_at,
        'approvalDueAt', v_control.approval_due_at
      ));
    end if;

    v_requested_at := statement_timestamp();
    v_due_at := v_requested_at + interval '24 hours';
    v_next_state := 'pending';
    v_action := case
      when v_control.approval_state = 'rejected' then 'account.approval_resubmitted'
      when v_control.approval_state = 'pending' then 'account.approval_profile_changed'
      when v_control.approval_state = 'approved' then 'account.approval_profile_changed'
      else 'account.approval_requested'
    end;

    update public.account_controls
    set approval_state = v_next_state,
        approval_requested_at = v_requested_at,
        approval_due_at = v_due_at,
        approval_decided_at = null,
        approval_decided_by = null,
        approval_rejection_reason = null
    where user_id = p_user_id;

    -- This audit intentionally contains state/timestamps only. Contact phone
    -- details stay on the narrow self profile and admin-queue read models.
    insert into public.admin_audit_log (
      actor_user_id,
      target_user_id,
      action,
      target_type,
      target_id,
      before_data,
      after_data
    ) values (
      p_user_id,
      p_user_id,
      v_action,
      'account_approval',
      p_user_id::text,
      jsonb_build_object('approvalState', v_control.approval_state),
      jsonb_build_object(
        'approvalState', v_next_state,
        'requestedAt', v_requested_at,
        'dueAt', v_due_at
      )
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'completed', true,
      'approvalState', v_next_state,
      'approvalRequestedAt', v_requested_at,
      'approvalDueAt', v_due_at
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke execute on function public.submit_profile_for_approval_from_trusted_server(
  uuid,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.submit_profile_for_approval_from_trusted_server(
  uuid,text,text,text,text,text,text
) to service_role;

-- The old authenticated RPCs cannot remain reachable: neither accepts a phone
-- nor moves a participant into manual review.
revoke execute on function public.update_profile(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.complete_profile_onboarding(text,text,text,text)
  from public, anon, authenticated, service_role;

drop function public.get_auth_context();
create function public.get_auth_context()
returns table (
  user_id uuid,
  email text,
  profile_id uuid,
  profile_name text,
  profile_surname text,
  profile_job text,
  profile_organization text,
  profile_phone_country_iso2 text,
  profile_phone_e164 text,
  profile_avatar_updated_at timestamptz,
  profile_onboarding_completed_at timestamptz,
  profile_identity_state text,
  profile_created_at timestamptz,
  profile_updated_at timestamptz,
  role public.product_role,
  status public.account_status,
  deletion_pending boolean,
  approval_state public.account_approval_state,
  approval_requested_at timestamptz,
  approval_due_at timestamptz,
  approval_decided_at timestamptz,
  approval_rejection_reason text,
  capabilities text[],
  has_current_legal_acceptance boolean
)
language sql
stable
security definer
set search_path = ''
rows 1
as $$
  select
    auth_user.id,
    auth_user.email::text,
    profile.id,
    profile.name,
    profile.surname,
    profile.job,
    profile.organization,
    profile.phone_country_iso2,
    profile.phone_e164,
    profile.avatar_updated_at,
    profile.onboarding_completed_at,
    private.identity_state(profile.id),
    profile.created_at,
    profile.updated_at,
    user_role.product_role,
    control.status,
    control.deletion_pending,
    control.approval_state,
    control.approval_requested_at,
    control.approval_due_at,
    control.approval_decided_at,
    control.approval_rejection_reason,
    public.get_my_capabilities(),
    private.has_current_legal_acceptance(profile.id)
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  join public.user_roles user_role on user_role.user_id = auth_user.id
  join public.account_controls control on control.user_id = auth_user.id
  where auth_user.id = (select auth.uid())
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp());
$$;

revoke execute on function public.get_auth_context() from public, anon, service_role;
grant execute on function public.get_auth_context() to authenticated;

comment on function public.submit_profile_for_approval_from_trusted_server(
  uuid,text,text,text,text,text,text
) is 'Service-only profile submission. Server must validate the country/phone pairing before invoking it.';
