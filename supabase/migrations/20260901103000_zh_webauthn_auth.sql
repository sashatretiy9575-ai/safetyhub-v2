-- Passwordless WebAuthn authentication for zh learners.
--
-- The public browser surface never receives the synthetic Auth email, recovery
-- digest, public key, stored counter, or raw challenge. Every mutable entry
-- point below is service-only except the capability-gated administrator reset.
-- Challenges are represented by SHA-256 receipts and expire within five
-- minutes. A Custom Access Token Hook consumes a short-lived session grant so
-- a synthetic identity cannot use the ordinary email OTP/magic-link surface.

create table private.zh_webauthn_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  user_handle text not null unique,
  auth_epoch bigint not null default 1 check (auth_epoch > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint zh_webauthn_accounts_user_handle_shape
    check (user_handle ~ '^[A-Za-z0-9_-]{43}$')
);

create table private.zh_webauthn_credentials (
  credential_id text primary key,
  user_id uuid not null references private.zh_webauthn_accounts(user_id) on delete cascade,
  public_key bytea not null,
  signature_counter bigint not null default 0 check (signature_counter >= 0),
  transports text[] not null default '{}',
  device_type text not null,
  backed_up boolean not null,
  state text not null default 'active',
  created_at timestamptz not null default statement_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  constraint zh_webauthn_credentials_id_shape
    check (credential_id ~ '^[A-Za-z0-9_-]{16,1024}$'),
  constraint zh_webauthn_credentials_public_key_size
    check (octet_length(public_key) between 32 and 4096),
  constraint zh_webauthn_credentials_transports
    check (
      transports <@ array['ble','cable','hybrid','internal','nfc','smart-card','usb']::text[]
      and cardinality(transports) <= 7
    ),
  constraint zh_webauthn_credentials_device_type
    check (device_type in ('singleDevice', 'multiDevice')),
  constraint zh_webauthn_credentials_state
    check (
      (state = 'active' and revoked_at is null and revoked_reason is null)
      or (
        state = 'revoked'
        and revoked_at is not null
        and revoked_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'
      )
    )
);

create index zh_webauthn_credentials_user_active_idx
  on private.zh_webauthn_credentials (user_id, created_at, credential_id)
  where state = 'active';

create table private.zh_webauthn_challenges (
  id uuid primary key,
  purpose text not null,
  challenge_sha256 text not null,
  request_hash text,
  user_handle text,
  user_id uuid references auth.users(id) on delete cascade,
  recovery_locator uuid,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint zh_webauthn_challenges_purpose
    check (purpose in ('registration', 'authentication', 'recovery')),
  constraint zh_webauthn_challenges_digest
    check (challenge_sha256 ~ '^[0-9a-f]{64}$'),
  constraint zh_webauthn_challenges_request_hash
    check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  constraint zh_webauthn_challenges_user_handle
    check (user_handle is null or user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  constraint zh_webauthn_challenges_lifetime
    check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  constraint zh_webauthn_challenges_consumed
    check (consumed_at is null or consumed_at >= created_at),
  constraint zh_webauthn_challenges_binding
    check (
      (purpose = 'registration' and request_hash is not null and user_handle is not null
        and user_id is null and recovery_locator is null)
      or (purpose = 'authentication' and request_hash is null and user_handle is null
        and user_id is null and recovery_locator is null)
      or (purpose = 'recovery' and request_hash is null and user_handle is not null
        and user_id is not null and recovery_locator is not null)
    )
);

create index zh_webauthn_challenges_expiry_idx
  on private.zh_webauthn_challenges (expires_at, id)
  where consumed_at is null;

create table private.zh_registration_operations (
  operation_id uuid primary key references private.zh_webauthn_challenges(id) on delete cascade,
  synthetic_email text not null unique,
  user_handle text not null unique,
  request_hash text not null,
  state text not null default 'prepared',
  auth_user_id uuid references auth.users(id) on delete set null,
  avatar_object_key text,
  avatar_sha256 text,
  avatar_bytes integer,
  cleanup_attempts integer not null default 0 check (cleanup_attempts between 0 and 20),
  cleanup_lease_until timestamptz,
  cleanup_last_error text,
  completed_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  constraint zh_registration_operations_email
    check (synthetic_email ~ '^[0-9a-f]{32}@auth[.]invalid$'),
  constraint zh_registration_operations_handle
    check (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  constraint zh_registration_operations_request_hash
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint zh_registration_operations_state
    check (state in (
      'prepared', 'auth_created', 'storage_written', 'completed',
      'cleanup_required', 'cleanup_claimed', 'cleaned'
    )),
  constraint zh_registration_operations_avatar
    check (
      (avatar_object_key is null and avatar_sha256 is null and avatar_bytes is null)
      or (
        (
          (
            auth_user_id is not null
            and avatar_object_key =
              auth_user_id::text || '/objects/' || operation_id::text || '.webp'
          )
          or (
            auth_user_id is null
            and state in ('cleanup_required', 'cleanup_claimed', 'cleaned')
            and avatar_object_key ~ (
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/objects/'
                || operation_id::text || '[.]webp$'
            )
          )
        )
        and avatar_sha256 ~ '^[0-9a-f]{64}$'
        and avatar_bytes between 1 and 102400
      )
    ),
  constraint zh_registration_operations_completion
    check ((state = 'completed') = (completed_at is not null)),
  constraint zh_registration_operations_cleanup_error
    check (
      cleanup_last_error is null
      or cleanup_last_error ~ '^[A-Z][A-Z0-9_]{2,63}$'
    )
);

create index zh_registration_operations_cleanup_idx
  on private.zh_registration_operations (updated_at, operation_id)
  where state in ('auth_created', 'storage_written', 'cleanup_required', 'cleanup_claimed');

create table private.zh_recovery_codes (
  locator uuid primary key,
  user_id uuid not null references private.zh_webauthn_accounts(user_id) on delete cascade,
  salt text not null,
  digest text not null,
  kind text not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz,
  consumed_at timestamptz,
  constraint zh_recovery_codes_salt check (salt ~ '^[0-9a-f]{32}$'),
  constraint zh_recovery_codes_digest check (digest ~ '^[0-9a-f]{64}$'),
  constraint zh_recovery_codes_kind check (kind in ('self_recovery', 'admin_reenrollment')),
  constraint zh_recovery_codes_expiry
    check (expires_at is null or expires_at > created_at),
  constraint zh_recovery_codes_consumed
    check (consumed_at is null or consumed_at >= created_at)
);

create unique index zh_recovery_codes_one_active_per_user_idx
  on private.zh_recovery_codes (user_id)
  where consumed_at is null;

create index zh_recovery_codes_expiry_idx
  on private.zh_recovery_codes (expires_at, locator)
  where consumed_at is null and expires_at is not null;

create table private.zh_session_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references private.zh_webauthn_accounts(user_id) on delete cascade,
  auth_epoch bigint not null check (auth_epoch > 0),
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '2 minutes',
  consumed_at timestamptz,
  constraint zh_session_grants_lifetime
    check (expires_at > created_at and expires_at <= created_at + interval '2 minutes'),
  constraint zh_session_grants_consumed
    check (consumed_at is null or consumed_at >= created_at)
);

create index zh_session_grants_claim_idx
  on private.zh_session_grants (user_id, expires_at, id)
  where consumed_at is null;

-- A refresh-token issuance receives a freshly rebuilt claim set from GoTrue;
-- arbitrary claims from the previous JWT are not an authorization channel.
-- Bind the exact Auth session UUID created by the granted magic-link exchange
-- instead, and keep the account epoch beside it for immediate reset revocation.
create table private.zh_authorized_sessions (
  session_id uuid primary key,
  user_id uuid not null references private.zh_webauthn_accounts(user_id) on delete cascade,
  auth_epoch bigint not null check (auth_epoch > 0),
  authorized_at timestamptz not null default statement_timestamp(),
  last_seen_at timestamptz not null default statement_timestamp(),
  constraint zh_authorized_sessions_seen_order
    check (last_seen_at >= authorized_at)
);

create index zh_authorized_sessions_user_epoch_idx
  on private.zh_authorized_sessions (user_id, auth_epoch, session_id);
create index zh_authorized_sessions_retention_idx
  on private.zh_authorized_sessions (last_seen_at, session_id);

create table private.zh_credential_reset_receipts (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '24 hours',
  primary key (actor_user_id, idempotency_key)
);

create index zh_credential_reset_receipts_expiry_idx
  on private.zh_credential_reset_receipts (expires_at, actor_user_id, idempotency_key);

revoke all on table
  private.zh_webauthn_accounts,
  private.zh_webauthn_credentials,
  private.zh_webauthn_challenges,
  private.zh_registration_operations,
  private.zh_recovery_codes,
  private.zh_session_grants,
  private.zh_authorized_sessions,
  private.zh_credential_reset_receipts
from public, anon, authenticated, service_role;

create function private.is_zh_synthetic_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.zh_webauthn_accounts account
    where account.user_id = p_user_id
  );
$$;

create function private.consume_zh_session_grant(
  p_user_id uuid,
  p_session_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant private.zh_session_grants%rowtype;
begin
  if p_session_id is null then return null; end if;
  select grant_row.* into v_grant
  from private.zh_session_grants grant_row
  join private.zh_webauthn_accounts account
    on account.user_id = grant_row.user_id
   and account.auth_epoch = grant_row.auth_epoch
  join public.account_controls control on control.user_id = account.user_id
  join auth.users auth_user on auth_user.id = account.user_id
  where grant_row.user_id = p_user_id
    and grant_row.consumed_at is null
    and grant_row.expires_at > statement_timestamp()
    and control.status = 'active'
    and not control.deletion_pending
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
  order by grant_row.created_at, grant_row.id
  limit 1
  for update of grant_row skip locked;

  if not found then return null; end if;
  update private.zh_session_grants
  set consumed_at = statement_timestamp()
  where id = v_grant.id;
  insert into private.zh_authorized_sessions (
    session_id, user_id, auth_epoch
  ) values (
    p_session_id, v_grant.user_id, v_grant.auth_epoch
  );
  return v_grant.auth_epoch;
end;
$$;

create function private.refresh_zh_authorized_session(
  p_user_id uuid,
  p_session_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_epoch bigint;
begin
  if p_session_id is null then return null; end if;
  update private.zh_authorized_sessions session_row
  set last_seen_at = statement_timestamp()
  from private.zh_webauthn_accounts account,
       public.account_controls control,
       auth.users auth_user
  where session_row.session_id = p_session_id
    and session_row.user_id = p_user_id
    and account.user_id = session_row.user_id
    and account.auth_epoch = session_row.auth_epoch
    and control.user_id = session_row.user_id
    and control.status = 'active'
    and not control.deletion_pending
    and auth_user.id = session_row.user_id
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null
      or auth_user.banned_until <= statement_timestamp())
    and exists (
      select 1
      from private.zh_webauthn_credentials credential
      where credential.user_id = session_row.user_id
        and credential.state = 'active'
    )
  returning session_row.auth_epoch into v_epoch;
  return v_epoch;
end;
$$;

revoke all on function private.is_zh_synthetic_user(uuid),
  private.consume_zh_session_grant(uuid,uuid),
  private.refresh_zh_authorized_session(uuid,uuid)
from public, anon, authenticated, service_role;

-- Extend the deny-by-default rate-limit catalogue with independent budgets for
-- registration, assertion, recovery, credential subject, and admin reset.
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
        'profile.update', 'legal.accept', 'content.article.mutate',
        'site.settings.update', 'admin.access.mutate', 'admin.test.mutate',
        'admin.zh_credential.reset', 'admin.invite', 'admin.suspend',
        'admin.delete', 'admin.reconcile', 'certificate.export'
      ) then 300
      else 60
    end;
$$;

create function public.prepare_zh_registration_operation(
  p_operation_id uuid,
  p_challenge_sha256 text,
  p_request_hash text,
  p_user_handle text,
  p_synthetic_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if p_operation_id is null
    or p_challenge_sha256 !~ '^[0-9a-f]{64}$'
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_user_handle !~ '^[A-Za-z0-9_-]{43}$'
    or p_synthetic_email !~ '^[0-9a-f]{32}@auth[.]invalid$' then
    raise exception using errcode = '22023', message = 'ZH_REGISTRATION_PREPARE_INVALID';
  end if;

  insert into private.zh_webauthn_challenges (
    id, purpose, challenge_sha256, request_hash, user_handle, expires_at
  ) values (
    p_operation_id, 'registration', p_challenge_sha256,
    p_request_hash, p_user_handle, v_expires_at
  );
  insert into private.zh_registration_operations (
    operation_id, synthetic_email, user_handle, request_hash
  ) values (
    p_operation_id, lower(p_synthetic_email), p_user_handle, p_request_hash
  );

  return jsonb_build_object('operationId', p_operation_id, 'expiresAt', v_expires_at);
end;
$$;

create function public.get_zh_registration_operation(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.zh_registration_operations%rowtype;
  v_challenge private.zh_webauthn_challenges%rowtype;
  v_recovered_user_id uuid;
begin
  select operation.* into v_operation
  from private.zh_registration_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if not found then return null; end if;

  select challenge.* into v_challenge
  from private.zh_webauthn_challenges challenge
  where challenge.id = p_operation_id;

  -- Recover an Auth Admin create whose HTTP response was lost. The exact
  -- email and operation marker are generated server-side and never leave this
  -- service-only result.
  if v_operation.auth_user_id is null and v_operation.state = 'prepared' then
    select auth_user.id into v_recovered_user_id
    from auth.users auth_user
    where lower(auth_user.email::text) = v_operation.synthetic_email
      and auth_user.deleted_at is null
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
      and auth_user.raw_app_meta_data ->> 'safetyhub_registration_operation_id'
        = p_operation_id::text
    order by auth_user.created_at, auth_user.id
    limit 1;
    if v_recovered_user_id is not null then
      update private.zh_registration_operations
      set auth_user_id = v_recovered_user_id,
          state = 'auth_created',
          updated_at = statement_timestamp()
      where operation_id = p_operation_id
      returning * into v_operation;
    end if;
  end if;

  return jsonb_build_object(
    'operationId', v_operation.operation_id,
    'state', v_operation.state,
    'challengeSha256', v_challenge.challenge_sha256,
    'requestHash', v_operation.request_hash,
    'userHandle', v_operation.user_handle,
    'syntheticEmail', v_operation.synthetic_email,
    'authUserId', v_operation.auth_user_id,
    'avatarObjectKey', v_operation.avatar_object_key,
    'expiresAt', v_challenge.expires_at,
    'consumedAt', v_challenge.consumed_at
  );
end;
$$;

create function public.attach_zh_registration_auth_user(
  p_operation_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.zh_registration_operations%rowtype;
begin
  select operation.* into v_operation
  from private.zh_registration_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ZH_REGISTRATION_NOT_FOUND';
  end if;
  if v_operation.state = 'completed' then
    return jsonb_build_object('state', 'completed', 'userId', v_operation.auth_user_id);
  end if;
  if v_operation.state not in ('prepared', 'auth_created') then
    raise exception using errcode = '55000', message = 'ZH_REGISTRATION_STATE_INVALID';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_user_id
      and lower(auth_user.email::text) = v_operation.synthetic_email
      and auth_user.deleted_at is null
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
      and auth_user.raw_app_meta_data ->> 'safetyhub_registration_operation_id'
        = p_operation_id::text
  ) then
    raise exception using errcode = '42501', message = 'ZH_SYNTHETIC_USER_NOT_OWNED';
  end if;
  if v_operation.auth_user_id is not null and v_operation.auth_user_id <> p_user_id then
    raise exception using errcode = '23505', message = 'ZH_REGISTRATION_AUTH_CONFLICT';
  end if;

  update private.zh_registration_operations
  set auth_user_id = p_user_id,
      state = 'auth_created',
      updated_at = statement_timestamp()
  where operation_id = p_operation_id;
  return jsonb_build_object('state', 'auth_created', 'userId', p_user_id);
end;
$$;

create function public.mark_zh_registration_storage_written(
  p_operation_id uuid,
  p_user_id uuid,
  p_object_key text,
  p_sha256 text,
  p_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.zh_registration_operations%rowtype;
begin
  select operation.* into v_operation
  from private.zh_registration_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if not found
    or v_operation.auth_user_id is distinct from p_user_id
    or v_operation.state not in ('auth_created', 'storage_written')
    or p_object_key is distinct from
      p_user_id::text || '/objects/' || p_operation_id::text || '.webp'
    or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_bytes not between 1 and 102400 then
    raise exception using errcode = '22023', message = 'ZH_REGISTRATION_STORAGE_INVALID';
  end if;
  if v_operation.state = 'storage_written'
    and (v_operation.avatar_object_key, v_operation.avatar_sha256, v_operation.avatar_bytes)
      is distinct from (p_object_key, p_sha256, p_bytes) then
    raise exception using errcode = '23505', message = 'ZH_REGISTRATION_STORAGE_CONFLICT';
  end if;

  update private.zh_registration_operations
  set avatar_object_key = p_object_key,
      avatar_sha256 = p_sha256,
      avatar_bytes = p_bytes,
      state = 'storage_written',
      updated_at = statement_timestamp()
  where operation_id = p_operation_id;
  return jsonb_build_object('state', 'storage_written', 'objectKey', p_object_key);
end;
$$;

create function public.finalize_zh_registration(
  p_operation_id uuid,
  p_request_hash text,
  p_credential_id text,
  p_public_key_base64 text,
  p_signature_counter bigint,
  p_transports text[],
  p_device_type text,
  p_backed_up boolean,
  p_name text,
  p_surname text,
  p_job text,
  p_organization text,
  p_phone_country_iso2 text,
  p_phone_e164 text,
  p_privacy_version text,
  p_privacy_body_revision text,
  p_terms_version text,
  p_terms_body_revision text,
  p_recovery_locator uuid,
  p_recovery_salt text,
  p_recovery_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.zh_registration_operations%rowtype;
  v_challenge private.zh_webauthn_challenges%rowtype;
  v_public_key bytea;
  v_requested_at timestamptz := statement_timestamp();
  v_name text := private.normalize_profile_text(p_name);
  v_surname text := private.normalize_profile_text(p_surname);
  v_job text := private.normalize_profile_text(p_job);
  v_organization text := private.normalize_profile_text(p_organization);
begin
  select operation.* into v_operation
  from private.zh_registration_operations operation
  where operation.operation_id = p_operation_id
  for update;
  select challenge.* into v_challenge
  from private.zh_webauthn_challenges challenge
  where challenge.id = p_operation_id
  for update;
  if v_operation.operation_id is null or v_challenge.id is null
    or v_operation.state <> 'storage_written'
    or v_operation.auth_user_id is null
    or v_operation.request_hash is distinct from p_request_hash
    or v_challenge.request_hash is distinct from p_request_hash
    or v_challenge.consumed_at is not null
    or v_challenge.expires_at <= statement_timestamp() then
    raise exception using errcode = '55000', message = 'ZH_REGISTRATION_EXPIRED';
  end if;
  if p_credential_id !~ '^[A-Za-z0-9_-]{16,1024}$'
    or p_public_key_base64 !~ '^[A-Za-z0-9+/]+={0,2}$'
    or p_signature_counter < 0
    or p_transports is null
    or not p_transports <@ array['ble','cable','hybrid','internal','nfc','smart-card','usb']::text[]
    or cardinality(p_transports) > 7
    or p_device_type not in ('singleDevice', 'multiDevice')
    or p_recovery_locator is null
    or p_recovery_salt !~ '^[0-9a-f]{32}$'
    or p_recovery_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ZH_CREDENTIAL_INVALID';
  end if;
  begin
    v_public_key := decode(p_public_key_base64, 'base64');
  exception when others then
    raise exception using errcode = '22023', message = 'ZH_PUBLIC_KEY_INVALID';
  end;
  if octet_length(v_public_key) not between 32 and 4096 then
    raise exception using errcode = '22023', message = 'ZH_PUBLIC_KEY_INVALID';
  end if;
  if char_length(v_name) not between 1 and 80
    or char_length(v_surname) not between 1 and 80
    or char_length(v_job) not between 1 and 160
    or char_length(v_organization) not between 1 and 160
    or v_name ~ '[[:cntrl:]]' or v_surname ~ '[[:cntrl:]]'
    or v_job ~ '[[:cntrl:]]' or v_organization ~ '[[:cntrl:]]'
    or p_phone_country_iso2 !~ '^[A-Z]{2}$'
    or p_phone_e164 !~ '^\+[1-9][0-9]{1,14}$' then
    raise exception using errcode = '22023', message = 'ZH_PROFILE_INVALID';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = v_operation.auth_user_id
      and lower(auth_user.email::text) = v_operation.synthetic_email
      and auth_user.deleted_at is null
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
  ) then
    raise exception using errcode = '42501', message = 'ZH_SYNTHETIC_USER_NOT_OWNED';
  end if;
  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'profile-avatars'
      and object.name = v_operation.avatar_object_key
  ) then
    raise exception using errcode = '55000', message = 'AVATAR_REQUIRED';
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

  insert into private.zh_webauthn_accounts (user_id, user_handle)
  values (v_operation.auth_user_id, v_operation.user_handle);
  insert into private.zh_webauthn_credentials (
    credential_id, user_id, public_key, signature_counter, transports,
    device_type, backed_up
  ) values (
    p_credential_id, v_operation.auth_user_id, v_public_key,
    p_signature_counter, coalesce(p_transports, '{}'), p_device_type, p_backed_up
  );
  insert into private.zh_recovery_codes (
    locator, user_id, salt, digest, kind
  ) values (
    p_recovery_locator, v_operation.auth_user_id,
    p_recovery_salt, p_recovery_digest, 'self_recovery'
  );

  update public.profiles
  set name = v_name,
      surname = v_surname,
      job = v_job,
      organization = v_organization,
      phone_country_iso2 = p_phone_country_iso2,
      phone_e164 = p_phone_e164,
      preferred_locale = 'zh',
      avatar_updated_at = v_requested_at,
      onboarding_completed_at = v_requested_at
  where id = v_operation.auth_user_id;
  if not found then
    raise exception using errcode = '55000', message = 'ZH_PROFILE_MISSING';
  end if;
  insert into private.profile_avatar_manifests (
    user_id, object_key, sha256, byte_length, operation_token,
    legacy_imported, updated_at
  ) values (
    v_operation.auth_user_id, v_operation.avatar_object_key,
    v_operation.avatar_sha256, v_operation.avatar_bytes,
    p_operation_id, false, v_requested_at
  );
  insert into public.legal_acceptances (
    user_id, document_type, version, accepted_at, source
  ) values
    (v_operation.auth_user_id, 'privacy', p_privacy_version, v_requested_at, 'registration'),
    (v_operation.auth_user_id, 'terms', p_terms_version, v_requested_at, 'registration');
  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours',
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_operation.auth_user_id;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    - 'safetyhub_registration_operation_id'
  where id = v_operation.auth_user_id;
  update private.zh_webauthn_challenges
  set consumed_at = v_requested_at
  where id = p_operation_id and consumed_at is null;
  update private.zh_registration_operations
  set state = 'completed', completed_at = v_requested_at,
      updated_at = v_requested_at
  where operation_id = p_operation_id;
  insert into private.zh_session_grants (user_id, auth_epoch)
  values (v_operation.auth_user_id, 1);
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data
  ) values (
    v_operation.auth_user_id, v_operation.auth_user_id,
    'account.approval_requested', 'account_approval',
    v_operation.auth_user_id::text,
    jsonb_build_object('approvalState', 'profile_incomplete'),
    jsonb_build_object(
      'approvalState', 'pending', 'locale', 'zh',
      'requestedAt', v_requested_at,
      'dueAt', v_requested_at + interval '24 hours'
    )
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'state', 'completed',
    'userId', v_operation.auth_user_id,
    'syntheticEmail', v_operation.synthetic_email,
    'approvalState', 'pending'
  ));
end;
$$;

create function public.prepare_zh_authentication_challenge(
  p_request_id uuid,
  p_challenge_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if p_request_id is null or p_challenge_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ZH_AUTH_CHALLENGE_INVALID';
  end if;
  insert into private.zh_webauthn_challenges (
    id, purpose, challenge_sha256, expires_at
  ) values (
    p_request_id, 'authentication', p_challenge_sha256, v_expires_at
  );
  return jsonb_build_object('requestId', p_request_id, 'expiresAt', v_expires_at);
end;
$$;

create function public.get_zh_authentication_context(
  p_request_id uuid,
  p_credential_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'requestId', challenge.id,
    'challengeSha256', challenge.challenge_sha256,
    'credentialId', credential.credential_id,
    'publicKeyBase64', encode(credential.public_key, 'base64'),
    'signatureCounter', credential.signature_counter,
    'transports', credential.transports,
    'userId', account.user_id,
    'userHandle', account.user_handle
  )
  from private.zh_webauthn_challenges challenge
  join private.zh_webauthn_credentials credential
    on credential.credential_id = p_credential_id
   and credential.state = 'active'
  join private.zh_webauthn_accounts account on account.user_id = credential.user_id
  join public.account_controls control on control.user_id = account.user_id
  join auth.users auth_user on auth_user.id = account.user_id
  where challenge.id = p_request_id
    and challenge.purpose = 'authentication'
    and challenge.consumed_at is null
    and challenge.expires_at > statement_timestamp()
    and control.status = 'active'
    and not control.deletion_pending
    and auth_user.deleted_at is null
    and lower(auth_user.email::text) ~ '^[0-9a-f]{32}@auth[.]invalid$'
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp());
$$;

create function public.complete_zh_authentication(
  p_request_id uuid,
  p_credential_id text,
  p_expected_counter bigint,
  p_new_counter bigint,
  p_backed_up boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.zh_webauthn_credentials%rowtype;
  v_account private.zh_webauthn_accounts%rowtype;
  v_email text;
begin
  select credential.* into v_credential
  from private.zh_webauthn_credentials credential
  where credential.credential_id = p_credential_id
    and credential.state = 'active'
  for update;
  if not found
    or v_credential.signature_counter is distinct from p_expected_counter
    or p_new_counter < 0
    or (
      (v_credential.signature_counter <> 0 or p_new_counter <> 0)
      and p_new_counter <= v_credential.signature_counter
    ) then
    raise exception using errcode = '55000', message = 'ZH_AUTHENTICATION_FAILED';
  end if;
  update private.zh_webauthn_challenges
  set consumed_at = statement_timestamp()
  where id = p_request_id
    and purpose = 'authentication'
    and consumed_at is null
    and expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '55000', message = 'ZH_AUTHENTICATION_FAILED';
  end if;
  update private.zh_webauthn_credentials
  set signature_counter = p_new_counter,
      backed_up = p_backed_up,
      last_used_at = statement_timestamp()
  where credential_id = p_credential_id;
  select account.* into v_account
  from private.zh_webauthn_accounts account
  where account.user_id = v_credential.user_id;
  select lower(auth_user.email::text) into v_email
  from auth.users auth_user
  join public.account_controls control on control.user_id = auth_user.id
  where auth_user.id = v_credential.user_id
    and auth_user.deleted_at is null
    and lower(auth_user.email::text) ~ '^[0-9a-f]{32}@auth[.]invalid$'
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
    and control.status = 'active'
    and not control.deletion_pending;
  if v_email is null then
    raise exception using errcode = '42501', message = 'ZH_AUTHENTICATION_FAILED';
  end if;
  insert into private.zh_session_grants (user_id, auth_epoch)
  values (v_account.user_id, v_account.auth_epoch);
  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', v_account.user_id,
    'syntheticEmail', v_email
  ));
end;
$$;

create function public.get_zh_recovery_context(p_locator uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'locator', recovery.locator,
    'userId', recovery.user_id,
    'userHandle', account.user_handle,
    'salt', recovery.salt,
    'digest', recovery.digest,
    'kind', recovery.kind,
    'expiresAt', recovery.expires_at,
    'activeCredentialIds', coalesce((
      select jsonb_agg(credential.credential_id order by credential.created_at)
      from private.zh_webauthn_credentials credential
      where credential.user_id = recovery.user_id and credential.state = 'active'
    ), '[]'::jsonb)
  )
  from private.zh_recovery_codes recovery
  join private.zh_webauthn_accounts account on account.user_id = recovery.user_id
  join public.account_controls control on control.user_id = recovery.user_id
  join auth.users auth_user on auth_user.id = recovery.user_id
  where recovery.locator = p_locator
    and recovery.consumed_at is null
    and (recovery.expires_at is null or recovery.expires_at > statement_timestamp())
    and control.status = 'active'
    and not control.deletion_pending
    and auth_user.deleted_at is null
    and lower(auth_user.email::text) ~ '^[0-9a-f]{32}@auth[.]invalid$'
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp());
$$;

create function public.prepare_zh_recovery_challenge(
  p_request_id uuid,
  p_locator uuid,
  p_challenge_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.zh_recovery_codes%rowtype;
  v_handle text;
  v_expires_at timestamptz := statement_timestamp() + interval '5 minutes';
begin
  select recovery.* into v_recovery
  from private.zh_recovery_codes recovery
  where recovery.locator = p_locator
    and recovery.consumed_at is null
    and (recovery.expires_at is null or recovery.expires_at > statement_timestamp());
  if not found or p_challenge_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '55000', message = 'ZH_RECOVERY_FAILED';
  end if;
  select account.user_handle into v_handle
  from private.zh_webauthn_accounts account
  where account.user_id = v_recovery.user_id;
  insert into private.zh_webauthn_challenges (
    id, purpose, challenge_sha256, user_handle, user_id,
    recovery_locator, expires_at
  ) values (
    p_request_id, 'recovery', p_challenge_sha256, v_handle,
    v_recovery.user_id, p_locator, v_expires_at
  );
  return jsonb_build_object('requestId', p_request_id, 'expiresAt', v_expires_at);
end;
$$;

create function public.get_zh_recovery_verification_context(
  p_request_id uuid,
  p_locator uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'requestId', challenge.id,
    'challengeSha256', challenge.challenge_sha256,
    'locator', recovery.locator,
    'userId', recovery.user_id,
    'userHandle', account.user_handle,
    'salt', recovery.salt,
    'digest', recovery.digest,
    'kind', recovery.kind,
    'expiresAt', recovery.expires_at
  )
  from private.zh_webauthn_challenges challenge
  join private.zh_recovery_codes recovery
    on recovery.locator = challenge.recovery_locator
   and recovery.user_id = challenge.user_id
  join private.zh_webauthn_accounts account on account.user_id = recovery.user_id
  where challenge.id = p_request_id
    and challenge.purpose = 'recovery'
    and challenge.recovery_locator = p_locator
    and challenge.consumed_at is null
    and challenge.expires_at > statement_timestamp()
    and recovery.consumed_at is null
    and (recovery.expires_at is null or recovery.expires_at > statement_timestamp());
$$;

create function public.complete_zh_recovery(
  p_request_id uuid,
  p_locator uuid,
  p_credential_id text,
  p_public_key_base64 text,
  p_signature_counter bigint,
  p_transports text[],
  p_device_type text,
  p_backed_up boolean,
  p_next_locator uuid,
  p_next_salt text,
  p_next_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.zh_recovery_codes%rowtype;
  v_account private.zh_webauthn_accounts%rowtype;
  v_public_key bytea;
  v_email text;
begin
  select recovery.* into v_recovery
  from private.zh_recovery_codes recovery
  where recovery.locator = p_locator
  for update;
  if not found or v_recovery.consumed_at is not null
    or (v_recovery.expires_at is not null and v_recovery.expires_at <= statement_timestamp())
    or p_next_locator is null or p_next_locator = p_locator
    or p_next_salt !~ '^[0-9a-f]{32}$'
    or p_next_digest !~ '^[0-9a-f]{64}$'
    or p_credential_id !~ '^[A-Za-z0-9_-]{16,1024}$'
    or p_signature_counter < 0
    or p_transports is null
    or not p_transports <@ array['ble','cable','hybrid','internal','nfc','smart-card','usb']::text[]
    or cardinality(p_transports) > 7
    or p_device_type not in ('singleDevice', 'multiDevice') then
    raise exception using errcode = '55000', message = 'ZH_RECOVERY_FAILED';
  end if;
  begin
    v_public_key := decode(p_public_key_base64, 'base64');
  exception when others then
    raise exception using errcode = '22023', message = 'ZH_RECOVERY_FAILED';
  end;
  if octet_length(v_public_key) not between 32 and 4096 then
    raise exception using errcode = '22023', message = 'ZH_RECOVERY_FAILED';
  end if;
  if not exists (
    select 1
    from public.account_controls control
    join auth.users auth_user on auth_user.id = control.user_id
    where control.user_id = v_recovery.user_id
      and control.status = 'active'
      and not control.deletion_pending
      and auth_user.deleted_at is null
      and lower(auth_user.email::text) ~ '^[0-9a-f]{32}@auth[.]invalid$'
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
      and (auth_user.banned_until is null
        or auth_user.banned_until <= statement_timestamp())
  ) then
    raise exception using errcode = '42501', message = 'ZH_RECOVERY_FAILED';
  end if;
  update private.zh_webauthn_challenges
  set consumed_at = statement_timestamp()
  where id = p_request_id
    and purpose = 'recovery'
    and recovery_locator = p_locator
    and user_id = v_recovery.user_id
    and consumed_at is null
    and expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '55000', message = 'ZH_RECOVERY_FAILED';
  end if;

  update private.zh_webauthn_credentials
  set state = 'revoked', revoked_at = statement_timestamp(),
      revoked_reason = 'RECOVERY_ROTATED'
  where user_id = v_recovery.user_id and state = 'active';
  delete from private.zh_authorized_sessions
  where user_id = v_recovery.user_id;
  insert into private.zh_webauthn_credentials (
    credential_id, user_id, public_key, signature_counter, transports,
    device_type, backed_up
  ) values (
    p_credential_id, v_recovery.user_id, v_public_key,
    p_signature_counter, p_transports, p_device_type, p_backed_up
  );
  update private.zh_recovery_codes
  set consumed_at = statement_timestamp()
  where locator = p_locator;
  insert into private.zh_recovery_codes (
    locator, user_id, salt, digest, kind
  ) values (
    p_next_locator, v_recovery.user_id, p_next_salt,
    p_next_digest, 'self_recovery'
  );
  update private.zh_webauthn_accounts
  set auth_epoch = auth_epoch + 1, updated_at = statement_timestamp()
  where user_id = v_recovery.user_id
  returning * into v_account;
  select lower(auth_user.email::text) into v_email
  from auth.users auth_user
  where auth_user.id = v_recovery.user_id
    and auth_user.deleted_at is null
    and lower(auth_user.email::text) ~ '^[0-9a-f]{32}@auth[.]invalid$'
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey';
  if v_email is null then
    raise exception using errcode = '42501', message = 'ZH_RECOVERY_FAILED';
  end if;
  insert into private.zh_session_grants (user_id, auth_epoch)
  values (v_account.user_id, v_account.auth_epoch);
  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', v_account.user_id,
    'syntheticEmail', v_email
  ));
end;
$$;

create function public.reset_zh_credential(
  p_target_user_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_locator uuid,
  p_salt text,
  p_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_reason text := private.normalize_profile_text(p_reason);
  v_request_hash text;
  v_receipt private.zh_credential_reset_receipts%rowtype;
  v_result jsonb;
  v_expires_at timestamptz := statement_timestamp() + interval '24 hours';
begin
  if p_target_user_id is null or p_idempotency_key is null
    or p_locator is distinct from p_idempotency_key
    or v_reason is null
    or char_length(v_reason) not between 10 and 500
    or v_reason ~ '[[:cntrl:]]'
    or p_salt !~ '^[0-9a-f]{32}$'
    or p_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ZH_RESET_INVALID';
  end if;
  if p_target_user_id = v_actor_id then
    raise exception using errcode = '42501', message = 'ZH_RESET_SELF_FORBIDDEN';
  end if;
  if not private.is_zh_synthetic_user(p_target_user_id) then
    raise exception using errcode = 'P0002', message = 'ZH_ACCOUNT_NOT_FOUND';
  end if;
  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'targetUserId', p_target_user_id,
    'reason', v_reason,
    'locator', p_locator,
    'salt', p_salt,
    'digest', p_digest
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_idempotency_key::text, 0
  ));
  select * into v_receipt
  from private.zh_credential_reset_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = '23000', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return private.ensure_rpc_payload(
      v_receipt.result || jsonb_build_object('replayed', true)
    );
  end if;

  perform private.enforce_actor_quota('admin.zh_credential.reset');
  update private.zh_webauthn_credentials
  set state = 'revoked', revoked_at = statement_timestamp(),
      revoked_reason = 'ADMIN_RESET'
  where user_id = p_target_user_id and state = 'active';
  delete from private.zh_authorized_sessions
  where user_id = p_target_user_id;
  update private.zh_recovery_codes
  set consumed_at = statement_timestamp()
  where user_id = p_target_user_id and consumed_at is null;
  insert into private.zh_recovery_codes (
    locator, user_id, salt, digest, kind, expires_at
  ) values (
    p_locator, p_target_user_id, p_salt, p_digest,
    'admin_reenrollment', v_expires_at
  );
  update private.zh_webauthn_accounts
  set auth_epoch = auth_epoch + 1, updated_at = statement_timestamp()
  where user_id = p_target_user_id;

  v_result := jsonb_build_object(
    'userId', p_target_user_id,
    'locator', p_locator,
    'expiresAt', v_expires_at,
    'replayed', false
  );
  insert into private.zh_credential_reset_receipts (
    actor_user_id, idempotency_key, request_hash, result
  ) values (v_actor_id, p_idempotency_key, v_request_hash, v_result);
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, reason, batch_id
  ) values (
    v_actor_id, p_target_user_id, 'zh_credential.reset',
    'zh_credential', p_target_user_id::text,
    jsonb_build_object('credentialState', 'active'),
    jsonb_build_object(
      'credentialState', 'reenrollment_required',
      'expiresAt', v_expires_at
    ),
    v_reason, p_idempotency_key
  );
  return private.ensure_rpc_payload(v_result);
end;
$$;

create function public.mark_zh_registration_cleanup_required(
  p_operation_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception using errcode = '22023', message = 'ZH_CLEANUP_ERROR_INVALID';
  end if;
  update private.zh_registration_operations
  set state = 'cleanup_required', cleanup_last_error = p_error_code,
      cleanup_lease_until = null, updated_at = statement_timestamp()
  where operation_id = p_operation_id
    and state in ('auth_created', 'storage_written', 'cleanup_required', 'cleanup_claimed');
end;
$$;

create function public.claim_zh_registration_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.zh_registration_operations%rowtype;
begin
  update private.zh_registration_operations operation
  set auth_user_id = auth_user.id,
      state = 'auth_created',
      updated_at = statement_timestamp()
  from auth.users auth_user
  where operation.state = 'prepared'
    and operation.auth_user_id is null
    and operation.updated_at < statement_timestamp() - interval '10 minutes'
    and lower(auth_user.email::text) = operation.synthetic_email
    and auth_user.deleted_at is null
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
    and auth_user.raw_app_meta_data ->> 'safetyhub_registration_operation_id'
      = operation.operation_id::text;

  select operation.* into v_operation
  from private.zh_registration_operations operation
  join private.zh_webauthn_challenges challenge on challenge.id = operation.operation_id
  where operation.auth_user_id is not null
    and operation.cleanup_attempts < 20
    and (
      operation.state = 'cleanup_required'
      or (operation.state in ('auth_created', 'storage_written')
        and operation.updated_at < statement_timestamp() - interval '10 minutes')
      or (operation.state = 'cleanup_claimed'
        and operation.cleanup_lease_until <= statement_timestamp())
    )
  order by operation.updated_at, operation.operation_id
  limit 1
  for update of operation skip locked;
  if not found then return null; end if;
  update private.zh_registration_operations
  set state = 'cleanup_claimed', cleanup_attempts = cleanup_attempts + 1,
      cleanup_lease_until = statement_timestamp() + interval '2 minutes',
      updated_at = statement_timestamp()
  where operation_id = v_operation.operation_id;
  return jsonb_build_object(
    'operationId', v_operation.operation_id,
    'userId', v_operation.auth_user_id,
    'objectKey', v_operation.avatar_object_key
  );
end;
$$;

create function public.finish_zh_registration_cleanup(
  p_operation_id uuid,
  p_success boolean,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not p_success and coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception using errcode = '22023', message = 'ZH_CLEANUP_ERROR_INVALID';
  end if;
  update private.zh_registration_operations
  set state = case when p_success then 'cleaned' else 'cleanup_required' end,
      auth_user_id = case when p_success then null else auth_user_id end,
      avatar_object_key = case when p_success then null else avatar_object_key end,
      avatar_sha256 = case when p_success then null else avatar_sha256 end,
      avatar_bytes = case when p_success then null else avatar_bytes end,
      cleanup_lease_until = null,
      cleanup_last_error = case when p_success then null else p_error_code end,
      updated_at = statement_timestamp()
  where operation_id = p_operation_id
    and state in ('cleanup_required', 'cleanup_claimed');
end;
$$;

create function public.prune_zh_webauthn_ephemera(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_challenges integer;
  v_grants integer;
  v_sessions integer;
  v_receipts integer;
begin
  with victims as (
    select id from private.zh_session_grants
    where expires_at < statement_timestamp() - interval '1 hour'
    order by expires_at, id limit v_limit for update skip locked
  )
  delete from private.zh_session_grants grant_row using victims
  where grant_row.id = victims.id;
  get diagnostics v_grants = row_count;

  with victims as (
    select session_id from private.zh_authorized_sessions
    where last_seen_at < statement_timestamp() - interval '90 days'
    order by last_seen_at, session_id limit v_limit for update skip locked
  )
  delete from private.zh_authorized_sessions session_row using victims
  where session_row.session_id = victims.session_id;
  get diagnostics v_sessions = row_count;

  with victims as (
    select id from private.zh_webauthn_challenges challenge
    where challenge.expires_at < statement_timestamp() - interval '24 hours'
      and not exists (
        select 1 from private.zh_registration_operations operation
        where operation.operation_id = challenge.id
          and (
            operation.state not in ('completed', 'cleaned', 'prepared')
            or (operation.state = 'prepared' and operation.auth_user_id is not null)
          )
      )
    order by expires_at, id limit v_limit for update skip locked
  )
  delete from private.zh_webauthn_challenges challenge using victims
  where challenge.id = victims.id;
  get diagnostics v_challenges = row_count;

  with victims as (
    select actor_user_id, idempotency_key
    from private.zh_credential_reset_receipts receipt
    where receipt.expires_at < statement_timestamp()
    order by expires_at, actor_user_id, idempotency_key
    limit v_limit for update skip locked
  )
  delete from private.zh_credential_reset_receipts receipt using victims
  where receipt.actor_user_id = victims.actor_user_id
    and receipt.idempotency_key = victims.idempotency_key;
  get diagnostics v_receipts = row_count;

  return jsonb_build_object(
    'challenges', v_challenges,
    'sessionGrants', v_grants,
    'authorizedSessions', v_sessions,
    'resetReceipts', v_receipts
  );
end;
$$;

-- Service-only RPC permissions. Private tables remain inaccessible even to a
-- raw service-role PostgREST table request.
revoke all on function public.prepare_zh_registration_operation(uuid,text,text,text,text),
  public.get_zh_registration_operation(uuid),
  public.attach_zh_registration_auth_user(uuid,uuid),
  public.mark_zh_registration_storage_written(uuid,uuid,text,text,integer),
  public.finalize_zh_registration(
    uuid,text,text,text,bigint,text[],text,boolean,text,text,text,text,text,text,
    text,text,text,text,uuid,text,text
  ),
  public.prepare_zh_authentication_challenge(uuid,text),
  public.get_zh_authentication_context(uuid,text),
  public.complete_zh_authentication(uuid,text,bigint,bigint,boolean),
  public.get_zh_recovery_context(uuid),
  public.prepare_zh_recovery_challenge(uuid,uuid,text),
  public.get_zh_recovery_verification_context(uuid,uuid),
  public.complete_zh_recovery(
    uuid,uuid,text,text,bigint,text[],text,boolean,uuid,text,text
  ),
  public.mark_zh_registration_cleanup_required(uuid,text),
  public.claim_zh_registration_cleanup(),
  public.finish_zh_registration_cleanup(uuid,boolean,text),
  public.prune_zh_webauthn_ephemera(integer)
from public, anon, authenticated, service_role;

grant execute on function public.prepare_zh_registration_operation(uuid,text,text,text,text),
  public.get_zh_registration_operation(uuid),
  public.attach_zh_registration_auth_user(uuid,uuid),
  public.mark_zh_registration_storage_written(uuid,uuid,text,text,integer),
  public.finalize_zh_registration(
    uuid,text,text,text,bigint,text[],text,boolean,text,text,text,text,text,text,
    text,text,text,text,uuid,text,text
  ),
  public.prepare_zh_authentication_challenge(uuid,text),
  public.get_zh_authentication_context(uuid,text),
  public.complete_zh_authentication(uuid,text,bigint,bigint,boolean),
  public.get_zh_recovery_context(uuid),
  public.prepare_zh_recovery_challenge(uuid,uuid,text),
  public.get_zh_recovery_verification_context(uuid,uuid),
  public.complete_zh_recovery(
    uuid,uuid,text,text,bigint,text[],text,boolean,uuid,text,text
  ),
  public.mark_zh_registration_cleanup_required(uuid,text),
  public.claim_zh_registration_cleanup(),
  public.finish_zh_registration_cleanup(uuid,boolean,text),
  public.prune_zh_webauthn_ephemera(integer)
to service_role;

revoke all on function public.reset_zh_credential(uuid,text,uuid,uuid,text,text)
  from public, anon, service_role;
grant execute on function public.reset_zh_credential(uuid,text,uuid,uuid,text,text)
  to authenticated;

-- Synthetic users accept only a server-issued magic-link token for which the
-- hook can consume a two-minute grant. The exact resulting GoTrue session UUID
-- is bound to auth_epoch; an admin reset invalidates every pre-reset refresh.
create or replace function public.enforce_email_otp_access_token(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authentication_method text := lower(
    replace(coalesce(event ->> 'authentication_method', ''), '"', '')
  );
  v_user_id uuid;
  v_is_zh boolean := false;
  v_epoch bigint;
  v_session_id uuid;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
  begin
    v_user_id := coalesce(nullif(event ->> 'user_id', ''), v_claims ->> 'sub')::uuid;
  exception when others then
    v_user_id := null;
  end;
  begin
    v_session_id := nullif(v_claims ->> 'session_id', '')::uuid;
  exception when others then
    v_session_id := null;
  end;
  if v_user_id is not null then
    select exists (
      select 1 from private.zh_webauthn_accounts account
      where account.user_id = v_user_id
    ) into v_is_zh;
  end if;

  if v_is_zh then
    -- Supabase requires both email and phone claims to remain present. Replace
    -- the provider-only synthetic address with an empty string, and remove
    -- optional verification companions, before a JWT can reach the browser.
    -- The stable subject UUID remains the only account identity claim.
    v_claims := (v_claims - 'email_verified' - 'phone_verified')
      || jsonb_build_object('email', '', 'phone', '');
    if v_authentication_method = 'magiclink' then
      v_epoch := private.consume_zh_session_grant(v_user_id, v_session_id);
      if v_epoch is not null then
        event := jsonb_set(
          event,
          '{claims}',
          v_claims || jsonb_build_object(
            'safetyhub_auth_kind', 'zh_passkey',
            'safetyhub_zh_epoch', v_epoch
          ),
          true
        );
        return event;
      end if;
    elsif v_authentication_method = 'token_refresh' then
      v_epoch := private.refresh_zh_authorized_session(v_user_id, v_session_id);
      if v_epoch is not null then
        event := jsonb_set(
          event,
          '{claims}',
          v_claims || jsonb_build_object(
            'safetyhub_auth_kind', 'zh_passkey',
            'safetyhub_zh_epoch', v_epoch
          ),
          true
        );
        return event;
      end if;
    end if;
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'PASSKEY_REQUIRED')
    );
  end if;

  if v_authentication_method = any (
    array['email/signup', 'otp', 'magiclink', 'token_refresh']
  ) then
    return event;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object('http_code', 403, 'message', 'EMAIL_OTP_REQUIRED')
  );
end;
$$;

revoke all on function public.enforce_email_otp_access_token(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_email_otp_access_token(jsonb)
  to supabase_auth_admin;

-- Hide the private synthetic email from the learner auth projection. The
-- session remains a normal Supabase cookie session, but no browser JSON needs
-- the provider's internal address.
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
  profile_preferred_locale public.app_locale,
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
    case when private.is_zh_synthetic_user(auth_user.id)
      then null else auth_user.email::text end,
    profile.id,
    profile.name,
    profile.surname,
    profile.job,
    profile.organization,
    profile.phone_country_iso2,
    profile.phone_e164,
    profile.preferred_locale,
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

-- Existing administrator directories were deliberately email-centric. Move
-- their proven capability/pagination implementations behind private wrappers
-- and redact only synthetic provider addresses at the final projection.
create function private.redact_zh_email_items(p_payload jsonb)
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
          when private.is_zh_synthetic_user((item.value ->> 'id')::uuid)
          then jsonb_set(
            jsonb_set(item.value, '{email}', 'null'::jsonb, true),
            '{label}',
            case
              when coalesce(item.value ->> 'label', '')
                ~* '^[0-9a-f]{32}@auth[.]invalid$'
              then 'null'::jsonb
              else coalesce(item.value -> 'label', 'null'::jsonb)
            end,
            true
          )
          else item.value
        end
        order by item.ordinality
      )
      from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
    ), '[]'::jsonb),
    true
  );
$$;

revoke all on function private.redact_zh_email_items(jsonb)
  from public, anon, authenticated, service_role;

alter function public.list_admin_access_users_page(integer,text,timestamptz,uuid)
  rename to list_admin_access_users_page_provider_internal;
alter function public.list_admin_access_users_page_provider_internal(
  integer,text,timestamptz,uuid
) set schema private;
revoke all on function private.list_admin_access_users_page_provider_internal(
  integer,text,timestamptz,uuid
) from public, anon, authenticated, service_role;

create function public.list_admin_access_users_page(
  p_limit integer default 25,
  p_query text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.redact_zh_email_items(
    private.list_admin_access_users_page_provider_internal(
      p_limit, p_query, p_cursor_created_at, p_cursor_id
    )
  );
$$;

revoke all on function public.list_admin_access_users_page(
  integer,text,timestamptz,uuid
) from public, anon, service_role;
grant execute on function public.list_admin_access_users_page(
  integer,text,timestamptz,uuid
) to authenticated;

alter function public.list_admin_users_page(
  integer,text,public.app_role,public.account_status,timestamptz,uuid
) rename to list_admin_users_page_provider_internal;
alter function public.list_admin_users_page_provider_internal(
  integer,text,public.app_role,public.account_status,timestamptz,uuid
) set schema private;
revoke all on function private.list_admin_users_page_provider_internal(
  integer,text,public.app_role,public.account_status,timestamptz,uuid
) from public, anon, authenticated, service_role;

create function public.list_admin_users_page(
  p_limit integer default 25,
  p_query text default null,
  p_role public.app_role default null,
  p_status public.account_status default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.redact_zh_email_items(
    private.list_admin_users_page_provider_internal(
      p_limit, p_query, p_role, p_status, p_cursor_created_at, p_cursor_id
    )
  );
$$;

revoke all on function public.list_admin_users_page(
  integer,text,public.app_role,public.account_status,timestamptz,uuid
) from public, anon, service_role;
grant execute on function public.list_admin_users_page(
  integer,text,public.app_role,public.account_status,timestamptz,uuid
) to authenticated;

alter function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  rename to list_pending_account_approval_page_provider_internal;
alter function public.list_pending_account_approval_page_provider_internal(
  integer,timestamptz,uuid
) set schema private;
revoke all on function private.list_pending_account_approval_page_provider_internal(
  integer,timestamptz,uuid
) from public, anon, authenticated, service_role;

create function public.list_pending_account_approval_page(
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
  select private.redact_zh_email_items(
    private.list_pending_account_approval_page_provider_internal(
      p_limit, p_cursor_due_at, p_cursor_user_id
    )
  );
$$;

revoke all on function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  from public, anon, service_role;
grant execute on function public.list_pending_account_approval_page(integer,timestamptz,uuid)
  to authenticated;

alter function public.list_learning_history_targets_page(
  uuid,integer,text,timestamptz,uuid
) rename to list_learning_history_targets_page_provider_internal;
alter function public.list_learning_history_targets_page_provider_internal(
  uuid,integer,text,timestamptz,uuid
) set schema private;
revoke all on function private.list_learning_history_targets_page_provider_internal(
  uuid,integer,text,timestamptz,uuid
) from public, anon, authenticated, service_role;

create function public.list_learning_history_targets_page(
  p_actor_id uuid,
  p_limit integer default 25,
  p_query text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.redact_zh_email_items(
    private.list_learning_history_targets_page_provider_internal(
      p_actor_id, p_limit, p_query, p_cursor_created_at, p_cursor_id
    )
  );
$$;

revoke all on function public.list_learning_history_targets_page(
  uuid,integer,text,timestamptz,uuid
) from public, anon, service_role;
grant execute on function public.list_learning_history_targets_page(
  uuid,integer,text,timestamptz,uuid
) to authenticated;

alter function public.get_admin_learning_history(uuid,uuid)
  rename to get_admin_learning_history_provider_internal;
alter function public.get_admin_learning_history_provider_internal(uuid,uuid)
  set schema private;
revoke all on function private.get_admin_learning_history_provider_internal(uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.get_admin_learning_history(
  p_actor_id uuid,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  v_payload := private.get_admin_learning_history_provider_internal(
    p_actor_id, p_target_user_id
  );
  if private.is_zh_synthetic_user(p_target_user_id) then
    v_payload := jsonb_set(v_payload, '{user,email}', 'null'::jsonb, true);
  end if;
  return v_payload;
end;
$$;

revoke all on function public.get_admin_learning_history(uuid,uuid)
  from public, anon, service_role;
grant execute on function public.get_admin_learning_history(uuid,uuid)
  to authenticated;

create function public.get_safe_user_email(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_zh_synthetic_user(auth_user.id) then null
    else auth_user.email::text
  end
  from auth.users auth_user
  where auth_user.id = p_user_id and auth_user.deleted_at is null;
$$;

revoke all on function public.get_safe_user_email(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_safe_user_email(uuid) to service_role;

comment on table private.zh_webauthn_credentials is
  'Server-only WebAuthn public keys and monotonic signature counters. Never expose through a browser read model.';
comment on table private.zh_recovery_codes is
  'One-use salted and server-peppered recovery digests. Plain recovery codes are never persisted.';
comment on function public.enforce_email_otp_access_token(jsonb) is
  'Custom Access Token Hook: email OTP for ordinary users; one-use server-granted passkey sessions and epoch-bound refresh for synthetic zh identities.';
