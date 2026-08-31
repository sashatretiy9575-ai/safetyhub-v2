-- Keep the learner-profile submission lock order consistent with the approval
-- gate used before a course attempt starts: account_controls first, then the
-- profile row.  This forward-only definition avoids the profile -> control /
-- control -> profile cycle without changing the approval lifecycle.

create or replace function public.submit_profile_for_approval_from_trusted_server(
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

    -- `private.require_approved_learner()` acquires account_controls before
    -- it reaches a learner profile/attempt lock.  Acquire the exclusive
    -- control lock first here as well, then lock the profile, so submitting a
    -- profile and starting a course cannot form an inverse row-lock cycle.
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

    select profile.* into v_profile
    from public.profiles profile
    where profile.id = p_user_id
    for update;
    if not found then
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

comment on function public.submit_profile_for_approval_from_trusted_server(
  uuid,text,text,text,text,text,text
) is 'Service-only profile submission. It locks account_controls before profiles to align with approval-gated learner access.';
