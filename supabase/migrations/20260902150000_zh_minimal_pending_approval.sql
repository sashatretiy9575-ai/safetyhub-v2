-- A ZH username/password registration is intentionally a minimal application:
-- the chosen Latin username and password are sufficient to create a pending
-- manual review.  It must not be routed through the regular profile, contact
-- telephone, or avatar prerequisites used by RU/KK/EN onboarding.
--
-- The account remains a participant, is still subject to legal acceptance,
-- and cannot access protected learner operations until an administrator
-- approves it.  Full profile onboarding remains available for ordinary flows
-- and is not weakened by this narrow ZH-only path.
create or replace function public.complete_zh_username_registration(
  p_user_id uuid,
  p_username text,
  p_synthetic_email text,
  p_privacy_version text,
  p_privacy_body_revision text,
  p_terms_version text,
  p_terms_body_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_requested_at timestamptz := statement_timestamp();
  v_due_at timestamptz := v_requested_at + interval '24 hours';
  v_control public.account_controls%rowtype;
  v_profile public.profiles%rowtype;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not private.runtime_feature_enabled('zh_username_password') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ZH_USERNAME_PASSWORD_ROLLOUT_DISABLED';
  end if;
  if p_user_id is null
    or p_username is distinct from v_username
    or v_username !~ '^[a-z][a-z0-9._-]{2,31}$'
    or p_synthetic_email !~ '^[0-9a-f]{32}@auth[.]invalid$' then
    raise exception using errcode = '22023', message = 'ZH_USERNAME_REGISTRATION_INVALID';
  end if;

  -- Match the established approval-submission lock order: the control row is
  -- locked before the profile row, so a login/approval transition cannot form
  -- an inverse cycle with approval-gated learner access.
  select control.* into v_control
  from public.account_controls control
  where control.user_id = p_user_id
  for update;
  if not found
    or v_control.status <> 'active'
    or v_control.deletion_pending then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;
  if v_control.approval_state <> 'profile_incomplete' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ZH_USERNAME_ACCOUNT_ALREADY_INITIALIZED';
  end if;
  if exists (
    select 1
    from public.user_roles user_role
    where user_role.user_id = p_user_id
      and user_role.product_role = 'admin'
  ) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ZH_USERNAME_ADMIN_ACCOUNT_FORBIDDEN';
  end if;

  select profile.* into v_profile
  from public.profiles profile
  where profile.id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;

  perform 1
  from auth.users auth_user
  where auth_user.id = p_user_id
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
    and lower(auth_user.email::text) = lower(p_synthetic_email)
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
      = 'zh_username_password'
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'ZH_USERNAME_ACCOUNT_NOT_OWNED';
  end if;

  perform 1
  from public.legal_document_versions privacy,
       public.legal_document_versions terms
  where privacy.document_type = 'privacy'
    and privacy.version = p_privacy_version
    and privacy.body_revision = p_privacy_body_revision
    and privacy.is_current
    and terms.document_type = 'terms'
    and terms.version = p_terms_version
    and terms.body_revision = p_terms_body_revision
    and terms.is_current
  for share of privacy, terms;
  if not found then
    raise exception using errcode = '55000', message = 'LEGAL_VERSION_OUTDATED';
  end if;

  insert into private.zh_username_accounts (user_id, username, synthetic_email)
  values (p_user_id, v_username, lower(p_synthetic_email));

  update public.profiles
  set preferred_locale = 'zh'
  where id = p_user_id
  returning * into v_profile;

  insert into public.legal_acceptances (
    user_id, document_type, version, accepted_at, source
  ) values
    (p_user_id, 'privacy', p_privacy_version, v_requested_at, 'registration'),
    (p_user_id, 'terms', p_terms_version, v_requested_at, 'registration');

  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_due_at,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = p_user_id
  returning * into v_control;

  -- No username, password, provider email, or contact data enters audit data.
  -- The username is exposed only through the identity.manage approval queue.
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data
  ) values
    (
      p_user_id, p_user_id, 'zh_username_password.created', 'zh_auth', p_user_id::text,
      null,
      jsonb_build_object('credential', 'username_password', 'locale', 'zh')
    ),
    (
      p_user_id, p_user_id, 'account.approval_requested', 'account_approval', p_user_id::text,
      jsonb_build_object('approvalState', 'profile_incomplete'),
      jsonb_build_object(
        'approvalState', 'pending',
        'requestedAt', v_requested_at,
        'dueAt', v_due_at,
        'locale', 'zh',
        'credential', 'username_password'
      )
    );

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_user_id,
    'approvalState', v_control.approval_state,
    'approvalRequestedAt', v_control.approval_requested_at,
    'approvalDueAt', v_control.approval_due_at
  ));
end;
$$;

revoke all on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
) to service_role;

-- This is intentionally narrower than the established approval gate: it is
-- usable only inside private learner functions and recognizes exactly a mapped
-- ZH username/password account that remains active, has selected ZH, and has
-- received an administrator's approval. It is not a profile-completion flag
-- and cannot authorize a pending or ordinary account.
create function private.is_approved_zh_username_learner(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.zh_username_accounts account
    join public.account_controls control
      on control.user_id = account.user_id
    join public.profiles profile
      on profile.id = account.user_id
    join auth.users auth_user
      on auth_user.id = account.user_id
    where account.user_id = p_user_id
      and profile.preferred_locale = 'zh'
      and control.status = 'active'
      and not control.deletion_pending
      and control.approval_state = 'approved'::public.account_approval_state
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_username_password'
      and lower(auth_user.email::text) = account.synthetic_email
  );
$$;

revoke all on function private.is_approved_zh_username_learner(uuid)
  from public, anon, authenticated, service_role;

-- The public start wrapper retains its existing active-account, approval,
-- current-legal-acceptance, quota, and locale guards. This inner override
-- exempts only the ordinary profile/avatar prerequisites for an already
-- approved mapped ZH learner. It does not write a fabricated profile state.
create or replace function private.start_test_attempt_unmetered(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_profile public.profiles%rowtype;
  v_test public.tests%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_attempt public.test_attempts%rowtype;
  v_count integer;
  v_local_date date;
  v_day_start timestamptz;
  v_retry_at timestamptz;
  v_is_approved_zh_username_learner boolean := false;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if v_user_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  -- Shared lock order for start/complete/history erase:
  -- catalogue lock -> user advisory lock -> profile/attempt row locks.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select profile.* into v_profile
  from public.profiles profile
  join public.account_controls control on control.user_id = profile.id
  where profile.id = v_user_id
    and control.status = 'active'
    and not control.deletion_pending
  for share of profile, control;
  if not found then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;

  v_is_approved_zh_username_learner :=
    private.is_approved_zh_username_learner(v_user_id);
  if not v_is_approved_zh_username_learner and (
    v_profile.onboarding_completed_at is null
    or char_length(v_profile.name) = 0
    or char_length(v_profile.surname) = 0
    or char_length(v_profile.job) = 0
    or char_length(v_profile.organization) = 0
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PROFILE_ONBOARDING_REQUIRED';
  end if;
  if not v_is_approved_zh_username_learner
    and v_profile.avatar_updated_at is null then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'AVATAR_REQUIRED';
  end if;
  if not private.has_current_legal_acceptance(v_user_id) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_ACCEPTANCE_REQUIRED';
  end if;

  select test.* into v_test
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  where test.slug = p_test_slug and test.status = 'published'
  for share of test;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = v_test.current_revision_id;

  -- The course-level lock additionally permits a strict per-course day count.
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':' || v_test.id::text, 0
  ));
  update public.test_attempts
  set status = 'expired', completed_at = statement_timestamp()
  where user_id = v_user_id
    and test_id = v_test.id
    and status = 'started'
    and expires_at <= statement_timestamp();

  select * into v_attempt
  from public.test_attempts
  where user_id = v_user_id and test_id = v_test.id and status = 'started'
  order by started_at desc, id desc
  limit 1;
  if found then
    return private.attempt_payload(v_attempt.id);
  end if;

  -- Maintenance freezes only admission of a new attempt. Existing attempts
  -- have already returned above and completion remains available.
  if private.course_catalog_maintenance_enabled() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_CATALOG_MAINTENANCE';
  end if;

  v_local_date := (statement_timestamp()
    at time zone v_revision.attempt_reset_timezone)::date;
  v_day_start := v_local_date::timestamp
    at time zone v_revision.attempt_reset_timezone;
  v_retry_at := (v_local_date + 1)::timestamp
    at time zone v_revision.attempt_reset_timezone;

  select count(*) into v_count
  from public.test_attempts
  where user_id = v_user_id
    and test_id = v_test.id
    and started_at >= v_day_start
    and started_at < v_retry_at;
  if v_count >= v_revision.attempts_per_calendar_day then
    raise exception using
      errcode = 'program_limit_exceeded',
      message = 'ATTEMPT_DAILY_LIMIT',
      detail = jsonb_build_object('retryAt', v_retry_at)::text;
  end if;

  perform private.ensure_legacy_revision_variant(v_revision.id);
  select * into v_variant
  from public.test_revision_variants variant
  where variant.revision_id = v_revision.id
  order by random()
  limit 1;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  insert into public.test_attempts (
    user_id, test_id, revision_id, variant_id, duration_minutes, pass_score,
    attempts_per_day, reset_timezone, expires_at
  ) values (
    v_user_id, v_test.id, v_revision.id, v_variant.id,
    v_revision.duration_minutes, v_revision.pass_score,
    v_revision.attempts_per_calendar_day, v_revision.attempt_reset_timezone,
    statement_timestamp() + make_interval(mins => v_revision.duration_minutes)
  ) returning * into v_attempt;

  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function private.start_test_attempt_unmetered(text)
  from public, anon, authenticated, service_role;

-- Generic Telegram approval events remain controlled by the existing
-- \`telegram_application_details = false\` production gate. This migration does
-- not enable it or alter its full-contact-details contract.

-- The general admin directories deliberately continue to redact the opaque
-- provider email.  Only the capability-gated pending-review queue receives the
-- login username, which gives an administrator a usable review identifier
-- without leaking it to a browser session, Telegram, broad directory, or audit.
create function private.add_zh_username_to_pending_approval_items(p_payload jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_set(
    p_payload,
    '{items}',
    coalesce((
      select jsonb_agg(
        case
          when account.username is null then item.value
          else jsonb_set(item.value, '{username}', to_jsonb(account.username), true)
        end
        order by item.ordinality
      )
      from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      left join private.zh_username_accounts account
        on account.user_id = (item.value ->> 'id')::uuid
    ), '[]'::jsonb),
    true
  );
$$;

revoke all on function private.add_zh_username_to_pending_approval_items(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.list_pending_account_approval_page(
  p_limit integer default 25,
  p_cursor_due_at timestamptz default null,
  p_cursor_user_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.add_zh_username_to_pending_approval_items(
    private.redact_zh_email_items(
      private.list_pending_account_approval_page_provider_internal(
        p_limit, p_cursor_due_at, p_cursor_user_id
      )
    )
  );
$$;

revoke all on function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  from public, anon, service_role;
grant execute on function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  to authenticated;

comment on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
) is
  'Service-only ZH username/password registration. It records legal acceptance and transitions a minimal participant application directly to pending manual review without profile, contact-phone, or avatar prerequisites.';
comment on function private.add_zh_username_to_pending_approval_items(jsonb) is
  'Adds a ZH username only to the already capability-gated pending-approval queue after provider-email redaction.';
comment on function private.is_approved_zh_username_learner(uuid) is
  'True only for an active, administrator-approved ZH username/password mapping with preferred locale ZH; used solely to bypass ordinary profile/avatar admission checks.';
comment on function private.start_test_attempt_unmetered(text) is
  'Starts an attempt after normal active-account and legal gates; only an active, approved mapped ZH username/password learner may omit the ordinary profile and avatar prerequisites.';
comment on function public.list_pending_account_approval_page(integer,timestamptz,uuid) is
  'Capability-gated minimal-PII manual learner-approval queue. ZH username/password entries expose only their canonical username, never the synthetic provider email.';
