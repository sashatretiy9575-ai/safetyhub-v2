-- Close three server-side boundaries without changing browser-visible learner
-- payloads: current legal acceptance is enforced at the shared learner gate,
-- email OTP verification is bound to a short-lived opaque challenge receipt,
-- and presentation relays receive durable actor/global concurrency leases.

create or replace function private.require_approved_learner()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_approval_state public.account_approval_state;
begin
  -- Preserve the established precedence: inactive/deleting accounts are
  -- rejected by require_active_user(), then approval is checked under the
  -- control-row lock, and only then is current legal acceptance evaluated.
  select control.approval_state
  into v_approval_state
  from public.account_controls control
  where control.user_id = v_user_id
    and control.status = 'active'
    and not control.deletion_pending
  for share;

  if not found
    or v_approval_state is distinct from 'approved'::public.account_approval_state then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'ACCOUNT_APPROVAL_REQUIRED';
  end if;

  if private.has_current_legal_acceptance(v_user_id) is not true then
    raise exception using
      errcode = '55000',
      message = 'LEGAL_ACCEPTANCE_REQUIRED';
  end if;

  return v_user_id;
end;
$$;

revoke all on function private.require_approved_learner()
  from public, anon, authenticated, service_role;

comment on function private.require_approved_learner() is
  'Returns the active actor only after manual approval and acceptance of both current legal documents.';
comment on function public.start_test_attempt(text) is
  'Starts an attempt only for an active, approved learner with both current legal acceptances.';
comment on function public.resume_test_attempt(text) is
  'Resumes an attempt only for an active, approved learner with both current legal acceptances.';
comment on function public.get_test_attempt(uuid) is
  'Returns an attempt only for its active, approved learner with both current legal acceptances.';
comment on function public.complete_test_attempt(uuid,jsonb) is
  'Completes an attempt only for its active, approved learner with both current legal acceptances.';
comment on function public.get_approved_course_presentation(text,text) is
  'Returns presentation metadata only to an active, approved learner with current legal acceptance.';
comment on function public.get_approved_course_presentation_locale(
  text, text, public.app_locale
) is
  'Returns localized presentation metadata only to an active, approved learner with current legal acceptance.';

-- Keep the latest deny-by-default catalogue intact while adding the independent
-- five-minute presentation transfer budget. Historical email-scoped actions
-- remain database-compatible, but the application no longer consumes them
-- before CAPTCHA or OTP proof.
create or replace function private.quota_policy(p_action text)
returns table (quota integer, window_seconds integer)
language sql
immutable
set search_path = ''
as $$
  select
    case p_action
      when 'certificate.pdf' then 20
      when 'certificate.export' then 5
      when 'presentation.download' then 12
      when 'attempt.start' then 30
      when 'attempt.complete' then 30
      when 'auth.register' then 10
      when 'auth.otp.start' then 20
      when 'auth.otp.start.email' then 5
      when 'auth.otp.verify' then 30
      when 'auth.otp.verify.email' then 6
      when 'auth.zh.registration.options' then 10
      when 'auth.zh.registration.verify' then 15
      when 'auth.zh.authentication.options' then 60
      when 'auth.zh.authentication.verify' then 30
      when 'auth.zh.authentication.credential' then 10
      when 'auth.zh.recovery.options' then 10
      when 'auth.zh.recovery.verify' then 10
      when 'auth.zh.recovery.locator' then 5
      when 'avatar.upload' then 12
      when 'profile.update' then 30
      when 'legal.accept' then 10
      when 'content.article.mutate' then 20
      when 'admin.attestation.mutate' then 20
      when 'admin.identity.mutate' then 20
      when 'admin.certificate.revoke' then 20
      when 'admin.access.mutate' then 10
      when 'admin.test.mutate' then 20
      when 'admin.zh_credential.reset' then 10
      when 'site.settings.update' then 10
      when 'admin.invite' then 10
      when 'admin.suspend' then 20
      when 'admin.delete' then 10
      when 'admin.reconcile' then 20
      else null
    end,
    case
      when p_action in ('auth.register', 'avatar.upload') then 3600
      when p_action in ('auth.otp.start', 'auth.otp.start.email') then 900
      when p_action in ('auth.otp.verify', 'auth.otp.verify.email') then 900
      when p_action in (
        'auth.zh.registration.options', 'auth.zh.recovery.options',
        'auth.zh.recovery.verify', 'auth.zh.recovery.locator'
      ) then 3600
      when p_action in (
        'auth.zh.registration.verify', 'auth.zh.authentication.options',
        'auth.zh.authentication.verify', 'auth.zh.authentication.credential'
      ) then 900
      when p_action in (
        'presentation.download', 'profile.update', 'legal.accept',
        'content.article.mutate', 'site.settings.update',
        'admin.access.mutate', 'admin.test.mutate',
        'admin.zh_credential.reset', 'admin.invite', 'admin.suspend',
        'admin.delete', 'admin.reconcile', 'certificate.export'
      ) then 300
      else 60
    end;
$$;

create table private.email_otp_challenges (
  challenge_hash text primary key,
  email_hash text not null,
  issued_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  attempt_count smallint not null default 0,
  max_attempts smallint not null default 6,
  constraint email_otp_challenge_hash_shape
    check (challenge_hash ~ '^[0-9a-f]{64}$'),
  constraint email_otp_challenge_email_hash_shape
    check (email_hash ~ '^[0-9a-f]{64}$'),
  constraint email_otp_challenge_expiry
    check (expires_at > issued_at and expires_at <= issued_at + interval '1 hour'),
  constraint email_otp_challenge_attempts
    check (max_attempts = 6 and attempt_count between 0 and max_attempts)
);

create index email_otp_challenges_expires_at_idx
  on private.email_otp_challenges (expires_at);

alter table private.email_otp_challenges enable row level security;
revoke all on table private.email_otp_challenges
  from public, anon, authenticated, service_role;

comment on table private.email_otp_challenges is
  'Opaque email OTP receipts. Only HMAC challenge/email bindings and bounded lifecycle metadata are stored.';

create function public.issue_email_otp_challenge(
  p_challenge_hash text,
  p_email_hash text,
  p_expires_in_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_challenge_hash is null
    or p_email_hash is null
    or p_challenge_hash !~ '^[0-9a-f]{64}$'
    or p_email_hash !~ '^[0-9a-f]{64}$'
    or p_expires_in_seconds is null
    or p_expires_in_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'OTP_CHALLENGE_INVALID';
  end if;

  -- Opportunistic cleanup is bounded; the explicit prune RPC remains available
  -- to an operator scheduler without making issue latency data-dependent.
  with expired as (
    select challenge.challenge_hash
    from private.email_otp_challenges challenge
    where challenge.expires_at <= statement_timestamp()
    order by challenge.expires_at, challenge.challenge_hash
    limit 100
    for update skip locked
  )
  delete from private.email_otp_challenges challenge
  using expired
  where challenge.challenge_hash = expired.challenge_hash;

  v_expires_at := statement_timestamp() + make_interval(secs => p_expires_in_seconds);
  insert into private.email_otp_challenges (
    challenge_hash, email_hash, expires_at
  ) values (
    p_challenge_hash, p_email_hash, v_expires_at
  );

  return jsonb_build_object('issued', true, 'expiresAt', v_expires_at);
end;
$$;

create function public.consume_email_otp_challenge_attempt(
  p_challenge_hash text,
  p_email_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge private.email_otp_challenges%rowtype;
  v_retry integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_challenge_hash is null
    or p_email_hash is null
    or p_challenge_hash !~ '^[0-9a-f]{64}$'
    or p_email_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('allowed', false, 'reason', 'invalid', 'retryAfter', 0);
  end if;

  select * into v_challenge
  from private.email_otp_challenges challenge
  where challenge.challenge_hash = p_challenge_hash
  for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'invalid', 'retryAfter', 0);
  end if;
  if v_challenge.expires_at <= statement_timestamp() then
    delete from private.email_otp_challenges challenge
    where challenge.challenge_hash = p_challenge_hash;
    return jsonb_build_object('allowed', false, 'reason', 'invalid', 'retryAfter', 0);
  end if;
  if v_challenge.email_hash is distinct from p_email_hash then
    return jsonb_build_object('allowed', false, 'reason', 'invalid', 'retryAfter', 0);
  end if;
  if v_challenge.attempt_count >= v_challenge.max_attempts then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_challenge.expires_at - statement_timestamp()
    )))::integer);
    return jsonb_build_object(
      'allowed', false, 'reason', 'exhausted', 'retryAfter', v_retry
    );
  end if;

  update private.email_otp_challenges challenge
  set attempt_count = challenge.attempt_count + 1
  where challenge.challenge_hash = p_challenge_hash
  returning * into v_challenge;

  return jsonb_build_object(
    'allowed', true,
    'attemptsRemaining', v_challenge.max_attempts - v_challenge.attempt_count,
    'retryAfter', 0
  );
end;
$$;

create function public.complete_email_otp_challenge(
  p_challenge_hash text,
  p_email_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_challenge_hash is null
    or p_email_hash is null
    or p_challenge_hash !~ '^[0-9a-f]{64}$'
    or p_email_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  delete from private.email_otp_challenges challenge
  where challenge.challenge_hash = p_challenge_hash
    and challenge.email_hash = p_email_hash
    and challenge.expires_at > statement_timestamp();
  v_deleted := found;
  return v_deleted;
end;
$$;

create function public.prune_email_otp_challenges(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'PRUNE_LIMIT_INVALID';
  end if;

  with expired as (
    select challenge.challenge_hash
    from private.email_otp_challenges challenge
    where challenge.expires_at <= statement_timestamp()
    order by challenge.expires_at, challenge.challenge_hash
    limit p_limit
    for update skip locked
  )
  delete from private.email_otp_challenges challenge
  using expired
  where challenge.challenge_hash = expired.challenge_hash;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function public.issue_email_otp_challenge(text,text,integer),
  public.consume_email_otp_challenge_attempt(text,text),
  public.complete_email_otp_challenge(text,text),
  public.prune_email_otp_challenges(integer)
from public, anon, authenticated, service_role;
grant execute on function public.issue_email_otp_challenge(text,text,integer),
  public.consume_email_otp_challenge_attempt(text,text),
  public.complete_email_otp_challenge(text,text),
  public.prune_email_otp_challenges(integer)
to service_role;

comment on function public.issue_email_otp_challenge(text,text,integer) is
  'Service-role-only issuance of an opaque HMAC-bound email OTP challenge receipt.';
comment on function public.consume_email_otp_challenge_attempt(text,text) is
  'Service-role-only atomic consumption of one of six challenge-bound OTP attempts.';
comment on function public.complete_email_otp_challenge(text,text) is
  'Service-role-only invalidation of an email OTP challenge after provider proof.';
comment on function public.prune_email_otp_challenges(integer) is
  'Service-role-only bounded cleanup of expired email OTP challenge receipts.';

create table private.course_presentation_download_leases (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  constraint course_presentation_download_lease_expiry
    check (expires_at > claimed_at and expires_at <= claimed_at + interval '5 minutes')
);

create index course_presentation_download_leases_actor_expires_idx
  on private.course_presentation_download_leases (actor_id, expires_at);
create index course_presentation_download_leases_expires_idx
  on private.course_presentation_download_leases (expires_at);

alter table private.course_presentation_download_leases enable row level security;
revoke all on table private.course_presentation_download_leases
  from public, anon, authenticated, service_role;

comment on table private.course_presentation_download_leases is
  'Short-lived deployment-wide presentation relay leases; maximum two per actor and twelve globally.';

create function public.claim_course_presentation_download_lease(
  p_actor_id uuid,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_count integer;
  v_global_count integer;
  v_lease_id uuid;
  v_next_expiry timestamptz;
  v_retry integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_actor_id is null
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 300
    or not exists (select 1 from auth.users auth_user where auth_user.id = p_actor_id) then
    raise exception using errcode = '22023', message = 'PRESENTATION_LEASE_INVALID';
  end if;

  -- One transaction-wide lock serializes cleanup, both capacity checks and the
  -- insert across every application instance.
  perform pg_catalog.pg_advisory_xact_lock(706163022606399291::bigint);
  delete from private.course_presentation_download_leases lease
  where lease.expires_at <= statement_timestamp();

  select count(*)::integer into v_actor_count
  from private.course_presentation_download_leases lease
  where lease.actor_id = p_actor_id;
  select count(*)::integer into v_global_count
  from private.course_presentation_download_leases;

  if v_actor_count >= 2 then
    select min(lease.expires_at) into v_next_expiry
    from private.course_presentation_download_leases lease
    where lease.actor_id = p_actor_id;
  elsif v_global_count >= 12 then
    select min(lease.expires_at) into v_next_expiry
    from private.course_presentation_download_leases lease;
  end if;

  if v_next_expiry is not null then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_next_expiry - statement_timestamp()
    )))::integer);
    return jsonb_build_object(
      'allowed', false, 'leaseId', null, 'retryAfter', v_retry
    );
  end if;

  insert into private.course_presentation_download_leases (
    actor_id, expires_at
  ) values (
    p_actor_id, statement_timestamp() + make_interval(secs => p_lease_seconds)
  ) returning id into v_lease_id;

  return jsonb_build_object(
    'allowed', true, 'leaseId', v_lease_id, 'retryAfter', 0
  );
end;
$$;

create function public.release_course_presentation_download_lease(
  p_lease_id uuid,
  p_actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_lease_id is null or p_actor_id is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(706163022606399291::bigint);
  delete from private.course_presentation_download_leases lease
  where lease.id = p_lease_id and lease.actor_id = p_actor_id;
  v_deleted := found;
  return v_deleted;
end;
$$;

revoke all on function public.claim_course_presentation_download_lease(uuid,integer),
  public.release_course_presentation_download_lease(uuid,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.claim_course_presentation_download_lease(uuid,integer),
  public.release_course_presentation_download_lease(uuid,uuid)
to service_role;

comment on function public.claim_course_presentation_download_lease(uuid,integer) is
  'Service-role-only atomic claim with TTL cleanup and actor/global concurrency ceilings.';
comment on function public.release_course_presentation_download_lease(uuid,uuid) is
  'Service-role-only idempotent release bound to the actor that owns the presentation lease.';
