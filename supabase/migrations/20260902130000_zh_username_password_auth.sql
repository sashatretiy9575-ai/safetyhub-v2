-- Chinese learner authentication cutover.
--
-- A Chinese learner supplies only a Latin username and password to the
-- application. Supabase still needs an email-shaped Auth identifier, so that
-- address is an opaque server-only mapping in private schema. It is never a
-- browser credential, a contact method, or a recovery channel. Passwords are
-- handled only by GoTrue and are never stored in application tables, RPCs, or
-- audit payloads.

-- This is an independent, fail-closed database release gate.  The browser
-- surface is separately guarded by SAFETYHUB_ZH_USERNAME_PASSWORD_ENABLED;
-- operators enable this receipt first so an accidental UI exposure cannot
-- create or authenticate a Chinese account before the database cutover is
-- deliberately authorized.  This forward replacement retains every existing
-- Telegram dependency rule from 20260902110000.
alter table private.runtime_feature_flags
  drop constraint runtime_feature_name;
alter table private.runtime_feature_flags
  add constraint runtime_feature_name check (
    feature_name in (
      'notification_events',
      'telegram_delivery',
      'telegram_application_details',
      'zh_username_password'
    )
  );

alter table private.runtime_feature_flag_receipts
  drop constraint runtime_feature_receipt_name;
alter table private.runtime_feature_flag_receipts
  add constraint runtime_feature_receipt_name check (
    feature_name in (
      'notification_events',
      'telegram_delivery',
      'telegram_application_details',
      'zh_username_password'
    )
  );

insert into private.runtime_feature_flags(feature_name, enabled)
values ('zh_username_password', false)
on conflict (feature_name) do nothing;

create or replace function public.set_runtime_feature_flag(
  p_feature_name text,
  p_enabled boolean,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing private.runtime_feature_flag_receipts%rowtype;
  v_before private.runtime_feature_flags%rowtype;
  v_after private.runtime_feature_flags%rowtype;
  v_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_feature_name is null
    or p_feature_name not in (
      'notification_events',
      'telegram_delivery',
      'telegram_application_details',
      'zh_username_password'
    )
    or p_enabled is null
    or p_idempotency_key is null
    or p_reason is null
    or char_length(p_reason) not between 8 and 500
    or p_reason ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation',
      message = 'RUNTIME_FEATURE_REQUEST_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_existing
  from private.runtime_feature_flag_receipts receipt
  where receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.feature_name <> p_feature_name
      or v_existing.requested_enabled <> p_enabled
      or v_existing.reason <> p_reason then
      raise exception using errcode = 'unique_violation',
        message = 'RUNTIME_FEATURE_IDEMPOTENCY_CONFLICT';
    end if;
    return v_existing.result;
  end if;

  select * into v_before
  from private.runtime_feature_flags flag
  where flag.feature_name = p_feature_name
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'RUNTIME_FEATURE_NOT_FOUND';
  end if;

  if p_feature_name = 'telegram_delivery'
    and p_enabled
    and not private.runtime_feature_enabled('notification_events') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_EVENTS_MUST_BE_ENABLED_FIRST';
  end if;
  if p_feature_name = 'telegram_application_details'
    and p_enabled
    and (
      not private.runtime_feature_enabled('notification_events')
      or not private.runtime_feature_enabled('telegram_delivery')
    ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_DELIVERY_MUST_BE_ENABLED_FIRST';
  end if;
  if p_feature_name = 'notification_events'
    and not p_enabled
    and (
      private.runtime_feature_enabled('telegram_delivery')
      or private.runtime_feature_enabled('telegram_application_details')
    ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_DEPENDENCIES_MUST_BE_DISABLED_FIRST';
  end if;
  if p_feature_name = 'telegram_delivery'
    and not p_enabled
    and private.runtime_feature_enabled('telegram_application_details') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_APPLICATION_DETAILS_MUST_BE_DISABLED_FIRST';
  end if;

  if v_before.enabled is distinct from p_enabled then
    update private.runtime_feature_flags
    set enabled = p_enabled,
        updated_at = statement_timestamp(),
        updated_by = (select auth.uid())
    where feature_name = p_feature_name
    returning * into v_after;

    insert into public.admin_audit_log (
      actor_user_id,
      action,
      target_type,
      target_id,
      before_data,
      after_data,
      reason,
      correlation_id
    ) values (
      (select auth.uid()),
      'runtime_feature.updated',
      'runtime_feature',
      p_feature_name,
      jsonb_build_object('enabled', v_before.enabled),
      jsonb_build_object('enabled', v_after.enabled),
      p_reason,
      p_idempotency_key
    );
  else
    v_after := v_before;
  end if;

  v_result := jsonb_build_object(
    'featureName', p_feature_name,
    'enabled', v_after.enabled,
    'changed', v_before.enabled is distinct from v_after.enabled,
    'updatedAt', v_after.updated_at
  );
  insert into private.runtime_feature_flag_receipts (
    idempotency_key,
    feature_name,
    requested_enabled,
    reason,
    result
  ) values (
    p_idempotency_key,
    p_feature_name,
    p_enabled,
    p_reason,
    v_result
  );

  if p_feature_name = 'telegram_delivery' and p_enabled then
    perform private.request_notification_dispatch('scheduled', null);
  end if;
  return v_result;
end;
$$;

create table private.zh_username_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  synthetic_email text not null unique,
  -- A recovery transition is deliberately fail-closed: the database disables
  -- every password session before GoTrue receives the replacement password.
  -- No password or reset token is retained in this state.
  password_change_pending boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  constraint zh_username_accounts_username_shape check (
    username = lower(username)
    and username ~ '^[a-z][a-z0-9._-]{2,31}$'
  ),
  constraint zh_username_accounts_synthetic_email_shape check (
    synthetic_email ~ '^[0-9a-f]{32}@auth[.]invalid$'
  )
);

create table private.zh_username_authorized_sessions (
  session_id uuid primary key,
  user_id uuid not null references private.zh_username_accounts(user_id) on delete cascade,
  authorized_at timestamptz not null default statement_timestamp(),
  last_seen_at timestamptz not null default statement_timestamp(),
  constraint zh_username_authorized_sessions_seen_order
    check (last_seen_at >= authorized_at)
);

create index zh_username_authorized_sessions_user_idx
  on private.zh_username_authorized_sessions (user_id, session_id);
create index zh_username_authorized_sessions_retention_idx
  on private.zh_username_authorized_sessions (last_seen_at, session_id);

alter table private.zh_username_accounts enable row level security;
alter table private.zh_username_authorized_sessions enable row level security;

revoke all on table private.zh_username_accounts,
  private.zh_username_authorized_sessions
from public, anon, authenticated, service_role;

-- Preserve the existing redaction callers while extending their definition of
-- a synthetic ZH identity to the username/password mapping.
create or replace function private.is_zh_synthetic_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.zh_webauthn_accounts legacy_account
    where legacy_account.user_id = p_user_id
  ) or exists (
    select 1
    from private.zh_username_accounts username_account
    where username_account.user_id = p_user_id
  );
$$;

create function private.authorize_zh_username_password_session(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized boolean := false;
begin
  if p_user_id is null or p_session_id is null then
    return false;
  end if;

  if not exists (
    select 1
    from private.zh_username_accounts account
    join public.account_controls control on control.user_id = account.user_id
    join auth.users auth_user on auth_user.id = account.user_id
    where account.user_id = p_user_id
      and not account.password_change_pending
      and private.runtime_feature_enabled('zh_username_password')
      and control.status = 'active'
      and not control.deletion_pending
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
        = 'zh_username_password'
  ) then
    return false;
  end if;

  insert into private.zh_username_authorized_sessions as session_row (
    session_id, user_id
  ) values (
    p_session_id, p_user_id
  )
  on conflict (session_id) do update
  set last_seen_at = statement_timestamp()
  where session_row.user_id = excluded.user_id
  returning true into v_authorized;

  return coalesce(v_authorized, false);
end;
$$;

create function private.refresh_zh_username_password_session(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorized boolean := false;
begin
  if p_user_id is null or p_session_id is null then
    return false;
  end if;

  update private.zh_username_authorized_sessions session_row
  set last_seen_at = statement_timestamp()
  from private.zh_username_accounts account,
       public.account_controls control,
       auth.users auth_user
  where session_row.session_id = p_session_id
    and session_row.user_id = p_user_id
    and account.user_id = session_row.user_id
    and not account.password_change_pending
    and private.runtime_feature_enabled('zh_username_password')
    and control.user_id = session_row.user_id
    and control.status = 'active'
    and not control.deletion_pending
    and auth_user.id = session_row.user_id
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
      = 'zh_username_password'
  returning true into v_authorized;

  return coalesce(v_authorized, false);
end;
$$;

-- New ZH password sessions are bound to the exact GoTrue session id.  Any
-- remaining legacy WebAuthn account is immediately denied here as well as in
-- the access-token hook: already-issued passkey JWTs receive no grace period
-- after this forward cutover.
create or replace function private.zh_session_epoch_is_current(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_session_id uuid;
begin
  if exists (
    select 1
    from private.zh_username_accounts username_account
    where username_account.user_id = p_user_id
  ) then
    if not private.runtime_feature_enabled('zh_username_password') then
      return false;
    end if;
    if v_claims ->> 'safetyhub_auth_kind' <> 'zh_username_password'
      or coalesce(v_claims ->> 'session_id', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return false;
    end if;
    begin
      v_session_id := (v_claims ->> 'session_id')::uuid;
    exception when others then
      return false;
    end;
    return exists (
      select 1
      from private.zh_username_authorized_sessions session_row
      join private.zh_username_accounts username_account
        on username_account.user_id = session_row.user_id
      where session_row.session_id = v_session_id
        and session_row.user_id = p_user_id
        and not username_account.password_change_pending
    );
  end if;

  if exists (
    select 1
    from private.zh_webauthn_accounts legacy_account
    where legacy_account.user_id = p_user_id
  ) then
    return false;
  end if;
  return true;
end;
$$;

-- The application server is the only caller.  Keeping this read service-only
-- prevents a browser from treating operational rollout state as an account
-- discovery signal.
create function public.get_zh_username_password_rollout_enabled()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  return private.runtime_feature_enabled('zh_username_password');
end;
$$;

create function public.complete_zh_username_registration(
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

  perform 1
  from auth.users auth_user
  where auth_user.id = p_user_id
    and auth_user.deleted_at is null
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
  where id = p_user_id;
  if not found then
    raise exception using errcode = '55000', message = 'ZH_USERNAME_PROFILE_MISSING';
  end if;

  insert into public.legal_acceptances (
    user_id, document_type, version, accepted_at, source
  ) values
    (p_user_id, 'privacy', p_privacy_version, v_requested_at, 'registration'),
    (p_user_id, 'terms', p_terms_version, v_requested_at, 'registration');

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
    'approvalState', 'profile_incomplete'
  ));
end;
$$;

create function public.get_zh_username_login_mapping(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not private.runtime_feature_enabled('zh_username_password') then
    return null;
  end if;
  if p_username is distinct from v_username
    or v_username !~ '^[a-z][a-z0-9._-]{2,31}$' then
    return null;
  end if;

  select jsonb_build_object(
    'userId', account.user_id,
    'syntheticEmail', account.synthetic_email
  ) into v_result
  from private.zh_username_accounts account
  join auth.users auth_user on auth_user.id = account.user_id
  where account.username = v_username
    and auth_user.deleted_at is null
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
      = 'zh_username_password';
  return v_result;
end;
$$;

-- This service-only read prevents the administrator password API from ever
-- updating a non-ZH account before it performs the database transition.
create function public.get_zh_username_provision_target(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_user_id is null then
    return null;
  end if;
  if exists (
    select 1
    from private.zh_username_accounts account
    where account.user_id = p_user_id
      and account.password_change_pending
  ) then
    return jsonb_build_object('state', 'username_password_pending', 'userId', p_user_id);
  end if;
  if exists (
    select 1 from private.zh_username_accounts account where account.user_id = p_user_id
  ) then
    return jsonb_build_object('state', 'username_password', 'userId', p_user_id);
  end if;
  if exists (
    select 1
    from private.zh_webauthn_accounts legacy_account
    join auth.users auth_user on auth_user.id = legacy_account.user_id
    where legacy_account.user_id = p_user_id
      and auth_user.deleted_at is null
      and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
  ) then
    return jsonb_build_object('state', 'legacy_passkey', 'userId', p_user_id);
  end if;
  return null;
end;
$$;

-- An administrator uses this only for the legacy WebAuthn-to-password
-- transition.  The mapping is first put into a disabled, recovery-pending
-- state before GoTrue receives a replacement password.  Thus a provider
-- failure leaves the account unavailable rather than usable with an old or
-- unrecorded credential.  The password itself never reaches this function.
create function public.provision_zh_username_password(
  p_target_user_id uuid,
  p_username text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_reason text := private.normalize_profile_text(p_reason);
  v_email text;
begin
  if p_target_user_id is null
    or p_target_user_id = v_actor_id
    or p_username is distinct from v_username
    or v_username !~ '^[a-z][a-z0-9._-]{2,31}$'
    or v_reason is null
    or char_length(v_reason) not between 10 and 500
    or v_reason ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'ZH_USERNAME_PROVISION_INVALID';
  end if;
  if exists (
    select 1 from private.zh_username_accounts account
    where account.user_id = p_target_user_id
  ) then
    raise exception using errcode = '23505', message = 'ZH_USERNAME_ALREADY_PROVISIONED';
  end if;

  select lower(auth_user.email::text) into v_email
  from private.zh_webauthn_accounts legacy_account
  join auth.users auth_user on auth_user.id = legacy_account.user_id
  where legacy_account.user_id = p_target_user_id
    and auth_user.deleted_at is null
    and lower(auth_user.email::text) ~ '^[0-9a-f]{32}@auth[.]invalid$'
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind' = 'zh_passkey'
  for update of legacy_account, auth_user;
  if v_email is null then
    raise exception using errcode = 'P0002', message = 'ZH_LEGACY_ACCOUNT_NOT_FOUND';
  end if;

  insert into private.zh_username_accounts (
    user_id, username, synthetic_email, password_change_pending
  ) values (
    p_target_user_id, v_username, v_email, true
  );

  update auth.users
  set raw_app_meta_data = (
    coalesce(raw_app_meta_data, '{}'::jsonb)
      - 'safetyhub_registration_operation_id'
      - 'safetyhub_auth_kind'
  ) || jsonb_build_object('safetyhub_auth_kind', 'zh_username_password')
  where id = p_target_user_id;

  delete from private.zh_webauthn_accounts
  where user_id = p_target_user_id;
  delete from private.zh_username_authorized_sessions
  where user_id = p_target_user_id;

  update public.profiles
  set preferred_locale = 'zh'
  where id = p_target_user_id;

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, reason
  ) values (
    v_actor_id, p_target_user_id, 'zh_username_password.provisioning_started',
    'zh_auth', p_target_user_id::text,
    jsonb_build_object('credential', 'passkey'),
    jsonb_build_object(
      'credential', 'username_password',
      'locale', 'zh',
      'passwordChangePending', true
    ),
    v_reason
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_target_user_id,
    'state', 'username_password_pending'
  ));
end;
$$;

-- Begin a password recovery before touching GoTrue.  A retry finds the same
-- pending state and can safely repeat the provider update; no password is
-- persisted between attempts.
create function public.begin_zh_username_password_reset(
  p_target_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_reason text := private.normalize_profile_text(p_reason);
  v_pending boolean;
begin
  if p_target_user_id is null
    or p_target_user_id = v_actor_id
    or v_reason is null
    or char_length(v_reason) not between 10 and 500
    or v_reason ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'ZH_USERNAME_RESET_INVALID';
  end if;
  select account.password_change_pending into v_pending
  from private.zh_username_accounts account
  join auth.users auth_user on auth_user.id = account.user_id
  where account.user_id = p_target_user_id
    and auth_user.deleted_at is null
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
      = 'zh_username_password'
  for update of account, auth_user;
  if not found then
    raise exception using errcode = 'P0002', message = 'ZH_USERNAME_ACCOUNT_NOT_FOUND';
  end if;

  delete from private.zh_username_authorized_sessions
  where user_id = p_target_user_id;

  if not v_pending then
    update private.zh_username_accounts
    set password_change_pending = true
    where user_id = p_target_user_id;

    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      before_data, after_data, reason
    ) values (
      v_actor_id, p_target_user_id, 'zh_username_password.reset_started',
      'zh_auth', p_target_user_id::text,
      jsonb_build_object('credential', 'username_password'),
      jsonb_build_object(
        'credential', 'username_password',
        'passwordChangePending', true,
        'sessionsRevoked', true
      ),
      v_reason
    );
  end if;

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_target_user_id,
    'state', 'username_password_pending',
    'sessionsRevoked', true
  ));
end;
$$;

-- This finalizes a successful server-to-GoTrue password update.  If the
-- database call is interrupted after the provider update, the account remains
-- disabled and an administrator repeats recovery; it never falls back to an
-- old password or a public self-service path.
create function public.complete_zh_username_password_reset(
  p_target_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_reason text := private.normalize_profile_text(p_reason);
  v_pending boolean;
begin
  if p_target_user_id is null
    or p_target_user_id = v_actor_id
    or v_reason is null
    or char_length(v_reason) not between 10 and 500
    or v_reason ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'ZH_USERNAME_RESET_INVALID';
  end if;
  select account.password_change_pending into v_pending
  from private.zh_username_accounts account
  join auth.users auth_user on auth_user.id = account.user_id
  where account.user_id = p_target_user_id
    and auth_user.deleted_at is null
    and auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
      = 'zh_username_password'
  for update of account, auth_user;
  if not found or not v_pending then
    raise exception using errcode = 'P0002', message = 'ZH_USERNAME_RECOVERY_NOT_PENDING';
  end if;

  update private.zh_username_accounts
  set password_change_pending = false
  where user_id = p_target_user_id;

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, reason
  ) values (
    v_actor_id, p_target_user_id, 'zh_username_password.reset_completed',
    'zh_auth', p_target_user_id::text,
    jsonb_build_object('credential', 'username_password', 'passwordChangePending', true),
    jsonb_build_object('credential', 'username_password', 'passwordChangePending', false),
    v_reason
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_target_user_id,
    'state', 'username_password'
  ));
end;
$$;

create function public.prune_zh_username_authorized_sessions(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_deleted integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  with victims as (
    select session_id
    from private.zh_username_authorized_sessions
    where last_seen_at < statement_timestamp() - interval '90 days'
    order by last_seen_at, session_id
    limit v_limit
    for update skip locked
  )
  delete from private.zh_username_authorized_sessions session_row
  using victims
  where session_row.session_id = victims.session_id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function private.is_zh_synthetic_user(uuid),
  private.authorize_zh_username_password_session(uuid,uuid),
  private.refresh_zh_username_password_session(uuid,uuid),
  private.zh_session_epoch_is_current(uuid)
from public, anon, authenticated, service_role;

revoke all on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
), public.get_zh_username_login_mapping(text),
  public.get_zh_username_password_rollout_enabled(),
  public.get_zh_username_provision_target(uuid),
  public.prune_zh_username_authorized_sessions(integer)
from public, anon, authenticated, service_role;
grant execute on function public.complete_zh_username_registration(
  uuid,text,text,text,text,text,text
), public.get_zh_username_login_mapping(text),
  public.get_zh_username_password_rollout_enabled(),
  public.get_zh_username_provision_target(uuid),
  public.prune_zh_username_authorized_sessions(integer)
to service_role;

revoke all on function public.provision_zh_username_password(uuid,text,text),
  public.begin_zh_username_password_reset(uuid,text),
  public.complete_zh_username_password_reset(uuid,text)
from public, anon, authenticated, service_role;
grant execute on function public.provision_zh_username_password(uuid,text,text),
  public.begin_zh_username_password_reset(uuid,text),
  public.complete_zh_username_password_reset(uuid,text)
to authenticated;

-- This supersedes the previous ZH passkey branch of the custom access-token
-- hook. RU/KK/EN retain the exact email OTP/magiclink rules below. A ZH
-- password session is accepted only when its exact GoTrue session id is
-- recorded server-side; refresh is therefore not a bypass for a legacy passkey
-- or any forbidden provider method.
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
  v_session_id uuid;
  v_is_zh_username boolean := false;
  v_is_legacy_zh boolean := false;
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
      select 1 from private.zh_username_accounts account
      where account.user_id = v_user_id
    ) into v_is_zh_username;
    select exists (
      select 1 from private.zh_webauthn_accounts account
      where account.user_id = v_user_id
    ) into v_is_legacy_zh;
  end if;

  if v_is_zh_username then
    v_claims := (v_claims - 'email_verified' - 'phone_verified')
      || jsonb_build_object('email', '', 'phone', '');
    if v_authentication_method = 'password'
      and private.authorize_zh_username_password_session(v_user_id, v_session_id) then
      return jsonb_set(
        event,
        '{claims}',
        v_claims || jsonb_build_object(
          'safetyhub_auth_kind', 'zh_username_password'
        ),
        true
      );
    elsif v_authentication_method = 'token_refresh'
      and private.refresh_zh_username_password_session(v_user_id, v_session_id) then
      return jsonb_set(
        event,
        '{claims}',
        v_claims || jsonb_build_object(
          'safetyhub_auth_kind', 'zh_username_password'
        ),
        true
      );
    end if;
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'ZH_USERNAME_PASSWORD_REQUIRED'
      )
    );
  end if;

  if v_is_legacy_zh then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'ZH_AUTH_METHOD_RETIRED'
      )
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

comment on table private.zh_username_accounts is
  'Server-only mapping from canonical Latin ZH username to an opaque synthetic Auth email. Passwords are not stored here.';
comment on table private.zh_username_authorized_sessions is
  'Exact GoTrue sessions issued through ZH username/password authentication; deleted on administrator-mediated recovery.';
comment on function public.enforce_email_otp_access_token(jsonb) is
  'Custom Access Token Hook: ZH accounts permit only server-mapped password authentication and its bound refresh; RU/KK/EN retain email OTP/magiclink only.';
