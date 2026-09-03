-- Chinese learners now follow exactly the same admission path as everyone else.
--
-- Until now a ZH username/password registration WAS the application: it jumped
-- straight to `pending` without ever collecting a name, position, company,
-- phone or photo, and private.start_test_attempt_unmetered waived the profile
-- and avatar prerequisites for such an account. The result was a dead end --
-- the learner could pass a test but never receive a certificate, because
-- issuance still requires a verified identity and a username is not a name
-- (see supabase/tests/zh_minimal_pending_approval.sql).
--
-- After this migration: register with a username and password, fill in the same
-- form as every other locale, wait for an administrator, then learn.

-- Registration creates only the credential and the legal acceptance. The account
-- stays at `profile_incomplete`; the ordinary
-- submit_profile_for_approval_from_trusted_server is the single transition into
-- `pending`, for every locale.
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

  -- Unchanged lock order: the control row is locked before the profile row, so
  -- a login/approval transition cannot form an inverse cycle with
  -- approval-gated learner access.
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

  -- No username, password, provider email, or contact data enters audit data.
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data
  ) values (
    p_user_id, p_user_id, 'zh_username_password.created', 'zh_auth', p_user_id::text,
    null,
    jsonb_build_object('credential', 'username_password', 'locale', 'zh')
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_user_id,
    'approvalState', v_control.approval_state,
    'approvalRequestedAt', null,
    'approvalDueAt', null
  ));
end;
$$;

revoke all on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
) to service_role;

comment on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
) is
  'Service-only ZH username/password registration. It records legal acceptance and leaves the account at profile_incomplete; the ordinary profile submission is what requests manual review.';

-- The profile and avatar prerequisites apply to every learner again.
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

  if (
    v_profile.onboarding_completed_at is null
    or char_length(v_profile.name) = 0
    or char_length(v_profile.surname) = 0
    or char_length(v_profile.job) = 0
    or char_length(v_profile.organization) = 0
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PROFILE_ONBOARDING_REQUIRED';
  end if;
  if v_profile.avatar_updated_at is null then
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
end;$$;

revoke all on function private.start_test_attempt_unmetered(text)
  from public, anon, authenticated, service_role;

comment on function private.start_test_attempt_unmetered(text) is
  'Starts an attempt after the normal active-account, profile, avatar and legal gates. No locale or credential type is exempt.';

drop function private.is_approved_zh_username_learner(uuid);

-- Existing Chinese accounts that were admitted without a profile. They cannot
-- start a test any more once the waiver above is gone, so leaving them
-- "approved" would only hide the reason. Send them back to the form instead.
-- Untouched: rejected accounts (their reason is meaningful history) and any ZH
-- account that already completed onboarding, including migrated passkey users.
do $backfill$
declare
  v_pending integer;
  v_approved integer;
  v_remaining integer;
begin
  select
    count(*) filter (where control.approval_state = 'pending'),
    count(*) filter (where control.approval_state = 'approved')
  into v_pending, v_approved
  from private.zh_username_accounts account
  join public.profiles profile on profile.id = account.user_id
  join public.account_controls control on control.user_id = account.user_id
  where profile.onboarding_completed_at is null
    and control.approval_state in ('pending', 'approved');

  raise notice 'zh full-profile admission: % pending, % approved to reset',
    v_pending, v_approved;

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data
  )
  select
    account.user_id,
    account.user_id,
    'account.approval_profile_required',
    'account_approval',
    account.user_id::text,
    jsonb_build_object('approvalState', control.approval_state),
    jsonb_build_object(
      'approvalState', 'profile_incomplete',
      'reason', 'zh_full_profile_admission'
    )
  from private.zh_username_accounts account
  join public.profiles profile on profile.id = account.user_id
  join public.account_controls control on control.user_id = account.user_id
  where profile.onboarding_completed_at is null
    and control.approval_state in ('pending', 'approved');

  update public.account_controls control
  set approval_state = 'profile_incomplete',
      approval_requested_at = null,
      approval_due_at = null,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  from private.zh_username_accounts account
  join public.profiles profile on profile.id = account.user_id
  where control.user_id = account.user_id
    and profile.onboarding_completed_at is null
    and control.approval_state in ('pending', 'approved');

  select count(*) into v_remaining
  from private.zh_username_accounts account
  join public.profiles profile on profile.id = account.user_id
  join public.account_controls control on control.user_id = account.user_id
  where profile.onboarding_completed_at is null
    and control.approval_state in ('pending', 'approved');

  if v_remaining <> 0 then
    raise exception 'ZH_FULL_PROFILE_ADMISSION_INCOMPLETE';
  end if;
  raise notice 'zh full-profile admission: reset complete';
end;
$backfill$;
