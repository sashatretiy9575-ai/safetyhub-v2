-- Keep actor quota consumption even when a domain mutation is rejected.
--
-- PostgreSQL rolls back all writes in a statement when a function raises.  A
-- metered RPC therefore catches errors from its domain implementation in an
-- inner subtransaction and returns a reserved error envelope.  The inner
-- writes roll back, while the quota increment made before the subtransaction
-- commits with the outer RPC statement.  Quota denial itself remains a native
-- RATE_LIMITED PostgreSQL error.

create function private.rpc_error_envelope(
  p_sqlstate text,
  p_message text,
  p_detail text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text := case
    when coalesce(p_sqlstate, '') ~ '^[0-9A-Z]{5}$' then p_sqlstate
    else 'P0001'
  end;
  v_message text;
  v_detail jsonb;
  v_retry_at_text text;
  v_retry_at timestamptz;
begin
  -- Custom SafetyHub domain messages are bounded machine tokens and may be
  -- forwarded. PostgreSQL-generated messages can contain schema detail or
  -- user data, so collapse them to a stable category and never return DETAIL,
  -- HINT, CONTEXT, query text, or parameter values.
  if coalesce(p_message, '') ~ '^[A-Z][A-Z0-9_]{1,95}(:[0-9]{1,10})?$' then
    v_message := p_message;
  else
    v_message := case
      when v_state = '42501' then 'FORBIDDEN'
      when v_state = '23505' then 'CONFLICT'
      when v_state in ('23502', '23503', '23514', '23P01') then 'CONSTRAINT_VIOLATION'
      when v_state in ('22003', '22007', '22023') then 'INVALID_REQUEST'
      when v_state = 'P0002' then 'NOT_FOUND'
      when v_state = '55000' then 'INVALID_STATE'
      when v_state in ('40001', '40P01') then 'RETRYABLE_TRANSACTION_ERROR'
      else 'RPC_MUTATION_FAILED'
    end;
  end if;

  -- ATTEMPT_ROLLING_LIMIT is the sole domain error whose safe recovery value
  -- is carried in PG_EXCEPTION_DETAIL. Accept only a one-key JSON object with
  -- a bounded ISO timestamp that round-trips through timestamptz. Everything
  -- else, including malformed or additional detail keys, is dropped.
  if v_state = '54000'
    and v_message = 'ATTEMPT_ROLLING_LIMIT'
    and p_detail is not null
    and octet_length(p_detail) between 20 and 96 then
    begin
      v_detail := p_detail::jsonb;
      if jsonb_typeof(v_detail) = 'object'
        and (select count(*) from jsonb_object_keys(v_detail)) = 1
        and v_detail ? 'retryAt'
        and jsonb_typeof(v_detail -> 'retryAt') = 'string' then
        v_retry_at_text := v_detail ->> 'retryAt';
        if char_length(v_retry_at_text) between 20 and 40
          and v_retry_at_text ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?([+-][0-9]{2}(:[0-9]{2})?|Z)$' then
          v_retry_at := v_retry_at_text::timestamptz;
          if v_retry_at is not null then
            v_detail := jsonb_build_object(
              'retryAt',
              to_char(v_retry_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            );
          else
            v_detail := null;
          end if;
        else
          v_detail := null;
        end if;
      else
        v_detail := null;
      end if;
    exception when others then
      v_detail := null;
    end;
  end if;

  return jsonb_build_object(
    '__safetyhubRpcError',
    jsonb_strip_nulls(jsonb_build_object(
      'version', 1,
      'code', v_state,
      'message', v_message,
      'details', v_detail
    ))
  );
end;
$$;

create function private.ensure_rpc_payload(p_payload jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_payload) = 'object' and p_payload ? '__safetyhubRpcError' then
    raise exception using errcode = 'check_violation',
      message = 'RPC_RESERVED_ENVELOPE_COLLISION';
  end if;
  return p_payload;
end;
$$;

-- Bulk domain implementations isolate individual rows and intentionally return
-- a successful result array. Never let PostgreSQL-generated exception text
-- escape through a per-row `reason`: retain only bounded SafetyHub machine
-- tokens and collapse every other string to a stable generic category.
create function private.sanitize_bulk_mutation_result(p_payload jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_payload) <> 'array' then p_payload
    else coalesce((
      select jsonb_agg(
        case
          when jsonb_typeof(item.value) = 'object'
            and item.value ->> 'status' = 'skipped'
            and item.value ? 'reason'
          then jsonb_set(
            item.value,
            '{reason}',
            to_jsonb(case
              when coalesce(item.value ->> 'reason', '')
                ~ '^[A-Z][A-Z0-9_]{1,95}(:[0-9]{1,10})?$'
              then item.value ->> 'reason'
              else 'OPERATION_SKIPPED'
            end),
            false
          )
          else item.value
        end
        order by item.ordinality
      )
      from jsonb_array_elements(p_payload) with ordinality as item(value, ordinality)
    ), '[]'::jsonb)
  end;
$$;

revoke all on function private.rpc_error_envelope(text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.ensure_rpc_payload(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.sanitize_bulk_mutation_result(jsonb)
  from public, anon, authenticated, service_role;

-- Extend the deny-by-default quota catalogue in this unapplied migration.
-- Registration is unauthenticated, so the application consumes only the
-- server-selected coarse network quota before it creates durable signup state.
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
      when 'avatar.upload' then 12
      when 'profile.update' then 30
      when 'legal.accept' then 10
      when 'content.article.mutate' then 20
      when 'admin.attestation.mutate' then 20
      when 'admin.identity.mutate' then 20
      when 'admin.certificate.revoke' then 20
      when 'admin.access.mutate' then 10
      when 'admin.test.mutate' then 20
      when 'site.settings.update' then 10
      when 'admin.invite' then 10
      when 'admin.suspend' then 20
      when 'admin.delete' then 10
      when 'admin.reconcile' then 20
      else null
    end,
    case
      when p_action in ('auth.register', 'avatar.upload') then 3600
      when p_action in (
        'profile.update', 'legal.accept', 'content.article.mutate',
        'site.settings.update', 'admin.access.mutate', 'admin.test.mutate',
        'admin.invite', 'admin.suspend', 'admin.delete', 'admin.reconcile',
        'certificate.export'
      ) then 300
      else 60
    end;
$$;

-- A browser cannot safely choose arbitrary quota action names. Authenticated
-- mutation RPCs call the private actor helper, while server-only operations
-- (avatar/PDF) charge an explicitly supplied active account through the
-- service-role function below.
create function private.consume_business_quota_for_actor(
  p_actor_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quota integer;
  v_window integer;
  v_row private.business_rate_limits%rowtype;
  v_now timestamptz := statement_timestamp();
  v_retry integer;
begin
  if p_actor_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'ACTOR_ID_REQUIRED';
  end if;
  if not exists (
    select 1
    from auth.users auth_user
    join public.account_controls control on control.user_id = auth_user.id
    where auth_user.id = p_actor_id
      and auth_user.deleted_at is null
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ACCOUNT_UNAVAILABLE';
  end if;

  select quota, window_seconds
  into v_quota, v_window
  from private.quota_policy(p_action);
  if v_quota is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'UNKNOWN_QUOTA_ACTION';
  end if;

  insert into private.business_rate_limits (
    actor_id, action, window_started_at, consumed
  ) values (
    p_actor_id, p_action, v_now, 1
  )
  on conflict (actor_id, action) do update
  set window_started_at = case
        when private.business_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then v_now
        else private.business_rate_limits.window_started_at
      end,
      consumed = case
        when private.business_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then 1
        else least(private.business_rate_limits.consumed, v_quota) + 1
      end
  returning * into v_row;

  if v_row.consumed > v_quota then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + make_interval(secs => v_window) - v_now
    )))::integer);
    return jsonb_build_object('allowed', false, 'retryAfter', v_retry);
  end if;
  return jsonb_build_object('allowed', true, 'retryAfter', 0);
end;
$$;

create or replace function public.consume_business_quota_for_actor(
  p_actor_id uuid,
  p_action text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.consume_business_quota_for_actor(p_actor_id, p_action);
$$;

create or replace function private.enforce_actor_quota(p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = 'insufficient_privilege',
      message = 'UNAUTHENTICATED';
  end if;
  v_result := private.consume_business_quota_for_actor(v_actor_id, p_action);
  if coalesce((v_result ->> 'allowed')::boolean, false) is not true then
    raise exception using
      errcode = 'program_limit_exceeded',
      message = 'RATE_LIMITED:' || greatest(
        1,
        coalesce((v_result ->> 'retryAfter')::integer, 1)
      );
  end if;
end;
$$;

create or replace function public.consume_coarse_ip_quota(
  p_action text,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quota integer;
  v_window integer;
  v_row private.coarse_ip_rate_limits%rowtype;
  v_now timestamptz := statement_timestamp();
  v_retry integer;
begin
  if p_ip_hash is null or char_length(p_ip_hash) not between 16 and 128 then
    raise exception using errcode = 'check_violation', message = 'IP_HASH_INVALID';
  end if;
  select quota, window_seconds into v_quota, v_window
  from private.quota_policy(p_action);
  if v_quota is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'UNKNOWN_QUOTA_ACTION';
  end if;
  v_quota := v_quota * 3;
  insert into private.coarse_ip_rate_limits (
    ip_hash, action, window_started_at, consumed
  ) values (
    p_ip_hash, p_action, v_now, 1
  )
  on conflict (ip_hash, action) do update
  set window_started_at = case
        when private.coarse_ip_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then v_now
        else private.coarse_ip_rate_limits.window_started_at
      end,
      consumed = case
        when private.coarse_ip_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then 1
        else least(private.coarse_ip_rate_limits.consumed, v_quota) + 1
      end
  returning * into v_row;
  if v_row.consumed > v_quota then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + make_interval(secs => v_window) - v_now
    )))::integer);
    return jsonb_build_object('allowed', false, 'retryAfter', v_retry);
  end if;
  return jsonb_build_object('allowed', true, 'retryAfter', 0);
end;
$$;

-- Coarse HMAC identifiers are operational anti-abuse state, not an audit log.
-- Keep only recently active windows and delete in bounded service batches.
create index coarse_ip_rate_limits_retention_idx
  on private.coarse_ip_rate_limits (window_started_at, ip_hash, action);

create function public.prune_coarse_ip_rate_limits(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_deleted integer;
begin
  with victims as (
    select rate.ip_hash, rate.action
    from private.coarse_ip_rate_limits rate
    where rate.window_started_at < statement_timestamp() - interval '24 hours'
    order by rate.window_started_at, rate.ip_hash, rate.action
    limit v_limit
    for update skip locked
  )
  delete from private.coarse_ip_rate_limits rate
  using victims
  where rate.ip_hash = victims.ip_hash and rate.action = victims.action;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke execute on function public.consume_business_quota(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.consume_business_quota_for_actor(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_business_quota_for_actor(uuid,text)
  to service_role;
revoke execute on function public.consume_coarse_ip_quota(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_coarse_ip_quota(text,text)
  to service_role;
revoke execute on function public.prune_coarse_ip_rate_limits(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_coarse_ip_rate_limits(integer)
  to service_role;
revoke all on function private.consume_business_quota_for_actor(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_actor_quota(text)
  from public, anon, authenticated, service_role;

-- Registration evidence is authorized by a durable, server-prepared
-- operation. Auth user metadata is only a correlation carrier: the database
-- stores the nonce hash, exact normalized email and exact legal revisions
-- before Auth is asked to create an identity.
drop trigger if exists on_auth_user_record_legal_acceptance on auth.users;
drop function if exists private.record_signup_legal_acceptance();
drop function if exists public.mark_signup_legal_acceptance(uuid,text,text);

create function private.lock_signup_legal_operations()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtextextended('safetyhub:signup-legal-operations', 0)
  );
$$;

revoke all on function private.lock_signup_legal_operations()
  from public, anon, authenticated, service_role;

create table private.signup_legal_operations (
  operation_id uuid primary key,
  nonce_sha256 bytea not null check (octet_length(nonce_sha256) = 32),
  normalized_email text not null check (
    normalized_email = lower(btrim(normalized_email))
    and char_length(normalized_email) between 3 and 320
  ),
  privacy_version text not null,
  privacy_body_revision text not null,
  terms_version text not null,
  terms_body_revision text not null,
  state text not null default 'prepared'
    check (state in ('prepared', 'completed', 'expired')),
  prepared_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  completed_user_id uuid,
  constraint signup_legal_operation_expiry check (
    expires_at > prepared_at
    and expires_at <= prepared_at + interval '24 hours'
  ),
  constraint signup_legal_operation_state check (
    (state = 'prepared' and completed_at is null and completed_user_id is null)
    or (state = 'completed' and completed_at is not null and completed_user_id is not null)
    or (state = 'expired' and completed_at is null and completed_user_id is null)
  )
);

create index signup_legal_operation_expiry_idx
  on private.signup_legal_operations (state, expires_at, operation_id);

create function public.prepare_signup_legal_operation(
  p_operation_id uuid,
  p_nonce_sha256 text,
  p_email text,
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
  v_email text := lower(btrim(p_email));
  v_nonce_sha256 bytea;
  v_existing private.signup_legal_operations%rowtype;
  v_expires_at timestamptz := statement_timestamp() + interval '24 hours';
begin
  perform private.lock_signup_legal_operations();
  if p_operation_id is null
    or coalesce(p_nonce_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(v_email) not between 3 and 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception using errcode = 'check_violation',
      message = 'SIGNUP_OPERATION_INVALID';
  end if;
  v_nonce_sha256 := decode(p_nonce_sha256, 'hex');

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
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_VERSION_OUTDATED';
  end if;

  select * into v_existing
  from private.signup_legal_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if found then
    if v_existing.nonce_sha256 = v_nonce_sha256
      and v_existing.normalized_email = v_email
      and v_existing.privacy_version = p_privacy_version
      and v_existing.privacy_body_revision = p_privacy_body_revision
      and v_existing.terms_version = p_terms_version
      and v_existing.terms_body_revision = p_terms_body_revision
      and v_existing.state in ('prepared', 'completed') then
      return jsonb_build_object(
        'status', v_existing.state,
        'operationId', v_existing.operation_id,
        'expiresAt', v_existing.expires_at
      );
    end if;
    raise exception using errcode = 'unique_violation',
      message = 'SIGNUP_OPERATION_CONFLICT';
  end if;

  insert into private.signup_legal_operations (
    operation_id, nonce_sha256, normalized_email,
    privacy_version, privacy_body_revision,
    terms_version, terms_body_revision, expires_at
  ) values (
    p_operation_id, v_nonce_sha256, v_email,
    p_privacy_version, p_privacy_body_revision,
    p_terms_version, p_terms_body_revision, v_expires_at
  );
  return jsonb_build_object(
    'status', 'prepared',
    'operationId', p_operation_id,
    'expiresAt', v_expires_at
  );
end;
$$;

create function public.finalize_signup_legal_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_signup_nonce text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.signup_legal_operations%rowtype;
  v_user auth.users%rowtype;
  v_identity auth.identities%rowtype;
  v_nonce_sha256 bytea;
begin
  perform private.lock_signup_legal_operations();
  if p_operation_id is null or p_user_id is null
    or coalesce(p_signup_nonce, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'not_owned', 'accepted', false);
  end if;
  v_nonce_sha256 := extensions.digest(convert_to(p_signup_nonce, 'utf8'), 'sha256');

  select * into v_operation
  from private.signup_legal_operations operation
  where operation.operation_id = p_operation_id
  for update;
  if not found or v_operation.nonce_sha256 <> v_nonce_sha256 then
    return jsonb_build_object('status', 'not_owned', 'accepted', false);
  end if;

  if v_operation.state = 'completed' then
    if v_operation.completed_user_id = p_user_id and (
      select count(*)
      from public.legal_acceptances acceptance
      where acceptance.user_id = p_user_id
        and acceptance.source = 'registration'
        and (acceptance.document_type, acceptance.version) in (
          ('privacy'::public.legal_document_type, v_operation.privacy_version),
          ('terms'::public.legal_document_type, v_operation.terms_version)
        )
    ) = 2 then
      return jsonb_build_object('status', 'completed', 'accepted', true);
    end if;
    return jsonb_build_object('status', 'not_owned', 'accepted', false);
  end if;
  if v_operation.state <> 'prepared'
    or v_operation.expires_at <= statement_timestamp() then
    update private.signup_legal_operations
    set state = 'expired'
    where operation_id = p_operation_id and state = 'prepared';
    return jsonb_build_object('status', 'expired', 'accepted', false);
  end if;

  select * into v_user
  from auth.users auth_user
  where auth_user.id = p_user_id
    and auth_user.deleted_at is null
  for update;
  if not found
    or lower(btrim(v_user.email)) is distinct from v_operation.normalized_email
    or v_user.created_at < v_operation.prepared_at
    or v_user.created_at > v_operation.expires_at
    or v_user.raw_user_meta_data ->> 'safetyhubSignupOperationId'
      is distinct from p_operation_id::text
    or v_user.raw_user_meta_data ->> 'safetyhubSignupNonce'
      is distinct from p_signup_nonce then
    return jsonb_build_object('status', 'not_owned', 'accepted', false);
  end if;

  select identity.* into v_identity
  from auth.identities identity
  where identity.user_id = p_user_id
    and identity.provider = 'email'
    and lower(btrim(identity.identity_data ->> 'email')) = v_operation.normalized_email
  order by identity.created_at, identity.id
  limit 1
  for update;
  if not found
    or v_identity.user_id is distinct from p_user_id
    or lower(btrim(v_identity.identity_data ->> 'email'))
      is distinct from v_operation.normalized_email
    or v_identity.identity_data ->> 'sub'
      is distinct from p_user_id::text then
    return jsonb_build_object('status', 'not_owned', 'accepted', false);
  end if;

  perform 1
  from public.legal_document_versions privacy,
       public.legal_document_versions terms
  where privacy.document_type = 'privacy'
    and privacy.version = v_operation.privacy_version
    and privacy.body_revision = v_operation.privacy_body_revision
    and privacy.is_current
    and terms.document_type = 'terms'
    and terms.version = v_operation.terms_version
    and terms.body_revision = v_operation.terms_body_revision
    and terms.is_current
  for share of privacy, terms;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_VERSION_OUTDATED';
  end if;

  insert into public.legal_acceptances (
    user_id, document_type, version, accepted_at, source
  ) values
    (p_user_id, 'privacy', v_operation.privacy_version,
      v_operation.prepared_at, 'registration'),
    (p_user_id, 'terms', v_operation.terms_version,
      v_operation.prepared_at, 'registration')
  on conflict do nothing;
  if (
    select count(*)
    from public.legal_acceptances acceptance
    where acceptance.user_id = p_user_id
      and acceptance.source = 'registration'
      and (acceptance.document_type, acceptance.version) in (
        ('privacy'::public.legal_document_type, v_operation.privacy_version),
        ('terms'::public.legal_document_type, v_operation.terms_version)
      )
  ) <> 2 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_ACCEPTANCE_INCOMPLETE';
  end if;

  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
    - 'safetyhubSignupOperationId' - 'safetyhubSignupNonce'
  where id = p_user_id;
  update auth.identities
  set identity_data = coalesce(identity_data, '{}'::jsonb)
    - 'safetyhubSignupOperationId' - 'safetyhubSignupNonce'
  where user_id = p_user_id;
  update private.signup_legal_operations
  set state = 'completed', completed_at = statement_timestamp(),
      completed_user_id = p_user_id
  where operation_id = p_operation_id;
  return jsonb_build_object('status', 'completed', 'accepted', true);
end;
$$;

create function public.prune_signup_legal_operations(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_expired integer;
  v_deleted integer;
begin
  perform private.lock_signup_legal_operations();
  with candidates as (
    select operation.operation_id
    from private.signup_legal_operations operation
    where operation.state = 'prepared'
      and operation.expires_at <= statement_timestamp()
    order by operation.expires_at, operation.operation_id
    limit v_limit
    for update skip locked
  )
  update private.signup_legal_operations operation
  set state = 'expired'
  from candidates
  where operation.operation_id = candidates.operation_id;
  get diagnostics v_expired = row_count;

  with candidates as (
    select operation.operation_id
    from private.signup_legal_operations operation
    where (
      operation.state = 'completed'
      and operation.completed_at < statement_timestamp() - interval '90 days'
    ) or (
      operation.state = 'expired'
      and operation.expires_at < statement_timestamp() - interval '30 days'
    )
    order by coalesce(operation.completed_at, operation.expires_at), operation.operation_id
    limit v_limit
    for update skip locked
  )
  delete from private.signup_legal_operations operation
  using candidates
  where operation.operation_id = candidates.operation_id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('expired', v_expired, 'deleted', v_deleted);
end;
$$;

revoke all on table private.signup_legal_operations
  from public, anon, authenticated, service_role;
revoke execute on function public.prepare_signup_legal_operation(
  uuid,text,text,text,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_signup_legal_operation(
  uuid,text,text,text,text,text,text
) to service_role;
revoke execute on function public.finalize_signup_legal_operation(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_signup_legal_operation(uuid,uuid,text)
  to service_role;
revoke execute on function public.prune_signup_legal_operations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_signup_legal_operations(integer)
  to service_role;

-- The canonical avatar marker is replaced below by an immutable-object
-- manifest and staged-operation state machine. Keeping the legacy service RPC
-- would permit canonical-first writes to bypass that state machine.
drop function if exists public.mark_profile_avatar_uploaded(uuid,timestamptz);

create table private.profile_avatar_manifests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer not null check (byte_length between 1 and 102400),
  operation_token uuid not null unique,
  legacy_imported boolean not null default false,
  updated_at timestamptz not null default statement_timestamp(),
  constraint profile_avatar_manifest_key check (
    (
      not legacy_imported
      and object_key = user_id::text || '/objects/' || operation_token::text || '.webp'
    ) or (
      legacy_imported
      and object_key = user_id::text || '/avatar.webp'
      and sha256 = repeat('0', 64)
      and byte_length = 1
    )
  )
);

-- Existing production avatars were written to a canonical key before the
-- immutable-object state machine existed. Preserve those exact, previously
-- authorized reads until the owner's next upload atomically replaces the
-- manifest; the reconciler then removes the legacy key as previousObjectKey.
insert into private.profile_avatar_manifests (
  user_id, object_key, sha256, byte_length, operation_token,
  legacy_imported, updated_at
)
select profile.id, profile.id::text || '/avatar.webp', repeat('0', 64), 1,
  gen_random_uuid(), true, profile.avatar_updated_at
from public.profiles profile
join public.account_controls control on control.user_id = profile.id
join auth.users auth_user on auth_user.id = profile.id
where profile.avatar_updated_at is not null
  and auth_user.deleted_at is null
  and not control.deletion_pending
on conflict (user_id) do nothing;

create function public.profile_avatar_object_is_committed(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.profile_avatar_manifests manifest
    join public.account_controls control on control.user_id = manifest.user_id
    where manifest.user_id = (select auth.uid())
      and manifest.object_key = p_object_name
      and control.status = 'active'
      and not control.deletion_pending
  );
$$;

create function public.get_profile_avatar_manifest(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'objectKey', manifest.object_key,
    'sha256', manifest.sha256,
    'bytes', manifest.byte_length,
    'legacyImported', manifest.legacy_imported,
    'updatedAt', manifest.updated_at
  )
  from private.profile_avatar_manifests manifest
  join public.account_controls control on control.user_id = manifest.user_id
  join auth.users auth_user on auth_user.id = manifest.user_id
  where manifest.user_id = p_user_id
    and auth_user.deleted_at is null
    and control.status = 'active'
    and not control.deletion_pending;
$$;

create function public.get_my_profile_avatar_manifest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_profile_avatar_manifest((select auth.uid()));
$$;

revoke execute on function public.profile_avatar_object_is_committed(text)
  from public, anon, authenticated, service_role;
grant execute on function public.profile_avatar_object_is_committed(text)
  to authenticated;
revoke execute on function public.get_profile_avatar_manifest(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_profile_avatar_manifest(uuid)
  to service_role;
revoke execute on function public.get_my_profile_avatar_manifest()
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_profile_avatar_manifest()
  to authenticated;

drop policy if exists profile_avatars_select_own on storage.objects;
create policy profile_avatars_select_own on storage.objects
for select to authenticated using (
  bucket_id = 'profile-avatars'
  and public.profile_avatar_object_is_committed(name)
);

-- Rare Auth-admin workflows are serialized globally. This deliberately trades
-- negligible admin throughput for a simple lock order that prevents prepare,
-- reconcile and purge from overtaking each other.
create function private.lock_auth_admin_outbox()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtextextended('safetyhub:auth-admin-outbox', 0)
  );
$$;

create function private.has_pending_auth_admin_operation(
  p_user_id uuid,
  p_email text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.state in ('prepared', 'external_succeeded', 'retryable')
      and (
        operation.actor_user_id = p_user_id
        or operation.target_id = p_user_id
        or (
          operation.operation_type in ('suspend', 'restore')
          and operation.payload ->> 'targetId' = p_user_id::text
        )
        or (
          operation.operation_type = 'invite'
          and nullif(p_email, '') is not null
          and lower(btrim(operation.payload ->> 'email')) = lower(btrim(p_email))
        )
      )
  );
$$;

revoke all on function private.lock_auth_admin_outbox()
  from public, anon, authenticated, service_role;
revoke all on function private.has_pending_auth_admin_operation(uuid,text)
  from public, anon, authenticated, service_role;

-- Reconciliation rows must survive an out-of-band Auth deletion attempt. The
-- official purge removes related terminal rows explicitly after every
-- nonterminal guard and Storage tombstone has passed.
alter table private.auth_admin_outbox
  drop constraint if exists auth_admin_outbox_actor_user_id_fkey;
alter table private.auth_admin_outbox
  add constraint auth_admin_outbox_actor_user_id_fkey
  foreign key (actor_user_id) references auth.users(id) on delete restrict;
alter table private.auth_admin_outbox
  add column if not exists processing_lease_expires_at timestamptz;

-- Stop the rollout before inheriting ambiguous pre-700 work. Such rows need a
-- deliberate operator reconciliation; guessing a target or deduplicating an
-- invite after an unknown Auth-side effect would be unsafe.
do $auth_admin_legacy_preflight$
begin
  if exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.state in ('prepared', 'external_succeeded', 'retryable')
      and operation.operation_type in ('suspend', 'restore')
      and (
        operation.target_id is null
        or coalesce(operation.payload ->> 'targetId', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or operation.target_id::text is distinct from operation.payload ->> 'targetId'
      )
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AUTH_ADMIN_LEGACY_TARGET_MISMATCH';
  end if;
  if exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.operation_type = 'invite'
      and operation.state in ('prepared', 'external_succeeded', 'retryable')
    group by lower(btrim(operation.payload ->> 'email'))
    having lower(btrim(operation.payload ->> 'email')) is null
      or count(*) > 1
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AUTH_ADMIN_LEGACY_INVITE_AMBIGUOUS';
  end if;
end;
$auth_admin_legacy_preflight$;

-- Upgrade any operations that were already in flight before this migration.
-- Existing handles receive a bounded compatibility lease; fail-closed local
-- suspension is established before application code can resume them.
update private.auth_admin_outbox
set processing_lease_expires_at = statement_timestamp() + interval '15 minutes'
where state in ('prepared', 'external_succeeded', 'retryable')
  and processing_lease_expires_at is null;
update public.account_controls control
set status = 'suspended',
    suspended_at = coalesce(control.suspended_at, statement_timestamp()),
    suspension_reason = coalesce(
      control.suspension_reason, 'AUTH_RECONCILIATION_PENDING'
    )
where not control.deletion_pending
  and exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.state in ('prepared', 'external_succeeded', 'retryable')
      and operation.operation_type in ('suspend', 'restore')
      and coalesce(
        operation.target_id::text, operation.payload ->> 'targetId'
      ) = control.user_id::text
  );
update private.auth_admin_outbox
set payload = jsonb_strip_nulls(jsonb_build_object(
      'targetId', target_id,
      'requestedRole', payload ->> 'requestedRole'
    )),
    last_error = case
      when state = 'committed' then null
      when last_error ~ '^[A-Z][A-Z0-9_]{1,95}$' then last_error
      else 'AUTH_ADMIN_LEGACY_FAILURE'
    end
where state in ('committed', 'rolled_back', 'failed');

insert into public.admin_audit_log (
  actor_user_id, target_user_id, action, target_type, target_id,
  after_data, correlation_id
)
select operation.actor_user_id,
  case when exists (
    select 1 from auth.users auth_user where auth_user.id = operation.target_id
  ) then operation.target_id else null end,
  'auth_operation.' || operation.state,
  'auth_admin_operation', operation.id::text,
  jsonb_strip_nulls(jsonb_build_object(
    'operationId', operation.id,
    'state', operation.state,
    'operationType', operation.operation_type,
    'legacyBackfill', true,
    'errorCategory', operation.last_error
  )),
  operation.correlation_id
from private.auth_admin_outbox operation
where operation.state in ('committed', 'rolled_back', 'failed')
  and not exists (
    select 1
    from public.admin_audit_log audit
    where audit.action = 'auth_operation.' || operation.state
      and audit.target_type = 'auth_admin_operation'
      and audit.target_id = operation.id::text
  );

create index auth_admin_outbox_live_invite_email_idx
  on private.auth_admin_outbox (
    lower(btrim(payload ->> 'email')), created_at, id
  )
  where operation_type = 'invite'
    and state in ('prepared', 'external_succeeded', 'retryable');

create or replace function private.new_auth_admin_operation(
  p_operation_type text,
  p_actor_id uuid,
  p_target_id uuid,
  p_payload jsonb,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform private.lock_auth_admin_outbox();
  insert into private.auth_admin_outbox (
    id, operation_type, actor_user_id, target_id, payload,
    completion_token_hash, correlation_id, processing_lease_expires_at
  ) values (
    v_id, p_operation_type, p_actor_id, p_target_id, p_payload,
    encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'),
    coalesce(p_correlation_id, gen_random_uuid()),
    statement_timestamp() + interval '5 minutes'
  );
  return jsonb_build_object('operationId', v_id, 'completionToken', v_token);
end;
$$;

revoke all on function private.new_auth_admin_operation(text,uuid,uuid,jsonb,uuid)
  from public, anon, authenticated, service_role;

-- Avatar bytes are uploaded to immutable, operation-specific Storage keys.
-- Publishing is the atomic manifest switch below; an old object is never
-- overwritten before that commit. External cleanup remains represented by a
-- durable row until a reconciler confirms the exact artifact was removed.
create table private.avatar_upload_operations (
  token uuid primary key,
  user_id uuid not null,
  state text not null default 'prepared' check (state in (
    'prepared', 'staged', 'reconcile_required', 'cancel_requested',
    'committed', 'aborted'
  )),
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_bytes integer not null check (expected_bytes between 1 and 102400),
  object_key text not null unique,
  previous_object_key text,
  started_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default statement_timestamp(),
  finalized_at timestamptz,
  artifacts_cleared_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  storage_write_lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  next_attempt_at timestamptz not null default statement_timestamp(),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,95}$'
  ),
  constraint avatar_upload_object_key check (
    object_key = user_id::text || '/objects/' || token::text || '.webp'
  ),
  constraint avatar_upload_expiry_shape check (
    expires_at > started_at
    and expires_at <= started_at + interval '15 minutes'
  ),
  constraint avatar_upload_terminal_shape check (
    (state in ('committed', 'aborted') and finalized_at is not null)
    or (state not in ('committed', 'aborted') and finalized_at is null)
  ),
  constraint avatar_upload_lease_shape check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  )
);

create unique index avatar_upload_one_live_per_user_idx
  on private.avatar_upload_operations (user_id)
  where state in (
    'prepared', 'staged', 'reconcile_required', 'cancel_requested'
  );
create index avatar_upload_reconcile_idx
  on private.avatar_upload_operations (
    next_attempt_at, expires_at, started_at, token
  )
  where state in ('reconcile_required', 'cancel_requested')
    or state in ('prepared', 'staged')
    or (state = 'committed' and artifacts_cleared_at is null);

create index avatar_upload_storage_write_lease_idx
  on private.avatar_upload_operations (
    storage_write_lease_expires_at, user_id, token
  ) where storage_write_lease_expires_at is not null;
create index avatar_upload_terminal_cleanup_idx
  on private.avatar_upload_operations (finalized_at, token)
  where state in ('committed', 'aborted') and artifacts_cleared_at is not null;

create function public.profile_avatar_storage_write_is_authorized(p_object_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_control public.account_controls%rowtype;
  v_operation private.avatar_upload_operations%rowtype;
begin
  if v_user_id is null or p_object_name is null then
    return false;
  end if;
  -- Storage checks INSERT permission before accepting object metadata. SHARE
  -- locks serialize that authorization decision with deletion_pending and
  -- operation-state changes. They do not span the external byte stream; the
  -- durable write lease and delayed reconciler gate remain the cleanup proof.
  select * into v_control
  from public.account_controls control
  where control.user_id = v_user_id
  for share;
  if not found or v_control.status <> 'active' or v_control.deletion_pending then
    return false;
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = v_user_id
    and operation.object_key = p_object_name
  for share;
  return found
    and v_operation.state = 'prepared'
    and v_operation.started_at + interval '2 minutes' > clock_timestamp()
    and v_operation.expires_at > clock_timestamp()
    and v_operation.storage_write_lease_expires_at > clock_timestamp();
end;
$$;

revoke execute on function public.profile_avatar_storage_write_is_authorized(text)
  from public, anon, authenticated, service_role;
grant execute on function public.profile_avatar_storage_write_is_authorized(text)
  to authenticated;

drop policy if exists profile_avatars_insert_live_operation on storage.objects;
create policy profile_avatars_insert_live_operation on storage.objects
for insert to authenticated with check (
  bucket_id = 'profile-avatars'
  and public.profile_avatar_storage_write_is_authorized(name)
);

-- Storage performs its RLS permission probe and final metadata upsert in
-- different transactions. Re-check the same durable operation at the final
-- storage.objects write so a cancellation/purge that wins the shared row locks
-- cannot be followed by a newly visible object. A raised exception also enters
-- Storage's exact-version compensating delete path; physical backend cleanup is
-- still monitored by the external orphan inventory/reconciler runbook.
create function private.guard_profile_avatar_storage_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_control public.account_controls%rowtype;
  v_operation private.avatar_upload_operations%rowtype;
begin
  if new.bucket_id is distinct from 'profile-avatars' then
    return new;
  end if;
  if new.name is null or new.name !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]webp$' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
  end if;
  v_user_id := split_part(new.name, '/', 1)::uuid;
  select * into v_control
  from public.account_controls control
  where control.user_id = v_user_id
  for share;
  if not found or v_control.status <> 'active' or v_control.deletion_pending then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = v_user_id and operation.object_key = new.name
  for share;
  if found
    and v_operation.state = 'prepared'
    and v_operation.started_at + interval '2 minutes' > clock_timestamp()
    and v_operation.expires_at > clock_timestamp()
    and v_operation.storage_write_lease_expires_at > clock_timestamp() then
    return new;
  end if;
  -- Internal maintenance of an already-published exact object remains valid;
  -- browser roles have no UPDATE policy and cannot reach this branch directly.
  if tg_op = 'UPDATE' and exists (
    select 1
    from private.profile_avatar_manifests manifest
    where manifest.user_id = v_user_id and manifest.object_key = new.name
    for share
  ) then
    return new;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
end;
$$;

drop trigger if exists profile_avatar_storage_write_guard on storage.objects;
create trigger profile_avatar_storage_write_guard
before insert or update on storage.objects
for each row execute function private.guard_profile_avatar_storage_write();

revoke all on function private.guard_profile_avatar_storage_write()
  from public, anon, authenticated, service_role;

create function public.begin_profile_avatar_upload(
  p_user_id uuid,
  p_expected_sha256 text,
  p_expected_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.account_status;
  v_deletion_pending boolean;
  v_live private.avatar_upload_operations%rowtype;
  v_token uuid := gen_random_uuid();
  v_object_key text;
  v_previous_object_key text;
  v_expires_at timestamptz := statement_timestamp() + interval '10 minutes';
begin
  if p_user_id is null
    or coalesce(p_expected_sha256, '') !~ '^[0-9a-f]{64}$'
    or p_expected_bytes not between 1 and 102400 then
    raise exception using errcode = 'check_violation',
      message = 'AVATAR_UPLOAD_METADATA_INVALID';
  end if;
  select control.status, control.deletion_pending
  into v_status, v_deletion_pending
  from public.account_controls control
  where control.user_id = p_user_id
  for update;
  if not found or v_status <> 'active' or v_deletion_pending then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ACCOUNT_UNAVAILABLE';
  end if;

  select * into v_live
  from private.avatar_upload_operations operation
  where operation.user_id = p_user_id
    and operation.state in (
      'prepared', 'staged', 'reconcile_required', 'cancel_requested'
    )
  for update;
  if found then
    if v_live.expires_at <= statement_timestamp()
      and v_live.state in ('prepared', 'staged') then
      update private.avatar_upload_operations
      set state = 'reconcile_required', updated_at = statement_timestamp(),
          next_attempt_at = statement_timestamp()
      where token = v_live.token;
      v_live.state := 'reconcile_required';
    end if;
    return jsonb_build_object(
      'status', case when v_live.state = 'reconcile_required'
        then 'reconcile_required' else 'in_progress' end,
      'operationToken', v_live.token,
      'objectKey', v_live.object_key,
      'expiresAt', v_live.expires_at
    );
  end if;

  select manifest.object_key into v_previous_object_key
  from private.profile_avatar_manifests manifest
  where manifest.user_id = p_user_id
  for share;
  v_object_key := p_user_id::text || '/objects/' || v_token::text || '.webp';
  insert into private.avatar_upload_operations (
    token, user_id, expected_sha256, expected_bytes, object_key,
    previous_object_key, expires_at, storage_write_lease_expires_at
  ) values (
    v_token, p_user_id, p_expected_sha256, p_expected_bytes, v_object_key,
    v_previous_object_key, v_expires_at,
    statement_timestamp() + interval '30 minutes'
  );
  return jsonb_build_object(
    'status', 'prepared',
    'operationToken', v_token,
    'objectKey', v_object_key,
    'expiresAt', v_expires_at
  );
end;
$$;

-- A Storage write is external to PostgreSQL. Keep an explicit bounded lease
-- from begin until the app reports that the upload attempt returned. Account
-- cleanup cannot begin its two empty scans while any such lease is live; a
-- crashed request is released by expiry.
create function public.finish_profile_avatar_storage_write(
  p_user_id uuid,
  p_operation_token uuid,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.avatar_upload_operations%rowtype;
  v_error_code text := case
    when coalesce(p_error_code, '') = '' then null
    when p_error_code ~ '^[A-Z][A-Z0-9_]{1,95}$' then p_error_code
    else 'AVATAR_STORAGE_WRITE_FAILED'
  end;
begin
  if p_user_id is null or p_operation_token is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'AVATAR_UPLOAD_OPERATION_INVALID';
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = p_user_id and operation.token = p_operation_token
  for update;
  if not found then
    return jsonb_build_object(
      'status', 'not_found', 'operationToken', p_operation_token
    );
  end if;
  update private.avatar_upload_operations
  set storage_write_lease_expires_at = null,
      updated_at = statement_timestamp(),
      last_error_code = coalesce(v_error_code, last_error_code)
  where token = p_operation_token;
  return jsonb_build_object(
    'status', v_operation.state,
    'operationToken', p_operation_token,
    'objectKey', v_operation.object_key
  );
end;
$$;

create function public.mark_profile_avatar_staged(
  p_user_id uuid,
  p_operation_token uuid,
  p_observed_sha256 text,
  p_observed_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.avatar_upload_operations%rowtype;
begin
  if p_user_id is null or p_operation_token is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'AVATAR_UPLOAD_OPERATION_INVALID';
  end if;
  perform 1
  from public.account_controls control
  where control.user_id = p_user_id
    and control.status = 'active'
    and not control.deletion_pending
  for update;
  if not found then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ACCOUNT_UNAVAILABLE';
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = p_user_id and operation.token = p_operation_token
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'AVATAR_UPLOAD_OPERATION_NOT_FOUND';
  end if;
  if v_operation.state in ('staged', 'committed')
    and v_operation.expected_sha256 is not distinct from p_observed_sha256
    and v_operation.expected_bytes is not distinct from p_observed_bytes then
    return jsonb_build_object(
      'status', v_operation.state,
      'operationToken', v_operation.token,
      'objectKey', v_operation.object_key
    );
  end if;
  if v_operation.state <> 'prepared'
    or v_operation.expires_at <= statement_timestamp()
    or coalesce(p_observed_sha256, '') !~ '^[0-9a-f]{64}$'
    or p_observed_bytes is null
    or v_operation.expected_sha256 is distinct from p_observed_sha256
    or v_operation.expected_bytes is distinct from p_observed_bytes then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_STAGING_PROOF_INVALID';
  end if;
  update private.avatar_upload_operations
  set state = 'staged', updated_at = statement_timestamp()
  where token = p_operation_token;
  return jsonb_build_object(
    'status', 'staged',
    'operationToken', p_operation_token,
    'objectKey', v_operation.object_key
  );
end;
$$;

create function public.finalize_profile_avatar_upload(
  p_user_id uuid,
  p_operation_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.avatar_upload_operations%rowtype;
  v_uploaded_at timestamptz;
begin
  if p_user_id is null or p_operation_token is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'AVATAR_UPLOAD_OPERATION_INVALID';
  end if;
  perform 1
  from public.account_controls control
  where control.user_id = p_user_id
    and control.status = 'active'
    and not control.deletion_pending
  for update;
  if not found then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ACCOUNT_UNAVAILABLE';
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = p_user_id and operation.token = p_operation_token
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'AVATAR_UPLOAD_OPERATION_NOT_FOUND';
  end if;
  if v_operation.state = 'committed' then
    select avatar_updated_at into v_uploaded_at
    from public.profiles where id = p_user_id;
    return jsonb_build_object(
      'status', 'committed', 'operationToken', p_operation_token,
      'objectKey', v_operation.object_key, 'avatarUpdatedAt', v_uploaded_at
    );
  end if;
  if v_operation.state <> 'staged'
    or v_operation.expires_at <= statement_timestamp() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_UPLOAD_RECONCILE_REQUIRED';
  end if;

  insert into private.profile_avatar_manifests (
    user_id, object_key, sha256, byte_length, operation_token, updated_at
  ) values (
    p_user_id, v_operation.object_key, v_operation.expected_sha256,
    v_operation.expected_bytes, p_operation_token, statement_timestamp()
  ) on conflict (user_id) do update
    set object_key = excluded.object_key,
        sha256 = excluded.sha256,
        byte_length = excluded.byte_length,
        operation_token = excluded.operation_token,
        legacy_imported = false,
        updated_at = excluded.updated_at;
  update public.profiles
  set avatar_updated_at = statement_timestamp()
  where id = p_user_id
  returning avatar_updated_at into v_uploaded_at;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  update private.avatar_upload_operations
  set state = 'committed', finalized_at = statement_timestamp(),
      updated_at = statement_timestamp(),
      artifacts_cleared_at = case when previous_object_key is null
        then statement_timestamp() else null end,
      next_attempt_at = statement_timestamp()
  where token = p_operation_token;
  return jsonb_build_object(
    'status', 'committed', 'operationToken', p_operation_token,
    'objectKey', v_operation.object_key, 'avatarUpdatedAt', v_uploaded_at
  );
end;
$$;

create function public.abort_profile_avatar_upload(
  p_user_id uuid,
  p_operation_token uuid,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.avatar_upload_operations%rowtype;
  v_error_code text := case
    when coalesce(p_error_code, '') ~ '^[A-Z][A-Z0-9_]{1,95}$'
      then p_error_code
    else 'AVATAR_UPLOAD_ABORTED'
  end;
begin
  if p_user_id is null or p_operation_token is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'AVATAR_UPLOAD_OPERATION_INVALID';
  end if;
  perform 1 from public.account_controls control
  where control.user_id = p_user_id for update;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.user_id = p_user_id and operation.token = p_operation_token
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found',
      'operationToken', p_operation_token);
  end if;
  if v_operation.state = 'committed' then
    return jsonb_build_object(
      'status', 'committed', 'operationToken', p_operation_token,
      'objectKey', v_operation.object_key
    );
  end if;
  update private.avatar_upload_operations
  set state = 'cancel_requested', updated_at = statement_timestamp(),
      next_attempt_at = statement_timestamp(), last_error_code = v_error_code
  where token = p_operation_token
    and state not in ('committed', 'aborted');
  return jsonb_build_object(
    'status', 'cancel_requested', 'operationToken', p_operation_token,
    'objectKey', v_operation.object_key
  );
end;
$$;

create function public.get_profile_avatar_upload_operation(
  p_user_id uuid,
  p_operation_token uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'status', operation.state,
    'operationToken', operation.token,
    'objectKey', operation.object_key,
    'expiresAt', operation.expires_at,
    'finalizedAt', operation.finalized_at,
    'avatarUpdatedAt', case when operation.state = 'committed'
      then profile.avatar_updated_at else null end
  ))
  from private.avatar_upload_operations operation
  left join public.profiles profile on profile.id = operation.user_id
  where operation.user_id = p_user_id
    and operation.token = p_operation_token;
$$;

create function public.claim_profile_avatar_reconciliation(
  p_worker_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_result jsonb;
begin
  if p_worker_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'WORKER_ID_REQUIRED';
  end if;
  with candidates as (
    select operation.token
    from private.avatar_upload_operations operation
    where (
      operation.state in ('reconcile_required', 'cancel_requested')
      or (operation.state in ('prepared', 'staged')
        and operation.expires_at <= statement_timestamp())
      or (operation.state = 'committed' and operation.artifacts_cleared_at is null)
    )
      and operation.next_attempt_at <= statement_timestamp()
      and (operation.storage_write_lease_expires_at is null
        or operation.storage_write_lease_expires_at <= statement_timestamp())
      and (operation.lease_expires_at is null
        or operation.lease_expires_at <= statement_timestamp())
    order by operation.next_attempt_at, operation.started_at, operation.token
    limit v_limit
    for update skip locked
  ), leased as (
    update private.avatar_upload_operations operation
    set state = case when operation.state in ('prepared', 'staged')
          then 'reconcile_required' else operation.state end,
        lease_owner = p_worker_id,
        lease_expires_at = statement_timestamp() + interval '5 minutes',
        attempt_count = least(operation.attempt_count + 1, 1000),
        updated_at = statement_timestamp()
    from candidates
    where operation.token = candidates.token
    returning operation.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'operationToken', leased.token,
    'userId', leased.user_id,
    'state', leased.state,
    'objectKey', leased.object_key,
    'previousObjectKey', leased.previous_object_key,
    'expectedSha256', leased.expected_sha256,
    'expectedBytes', leased.expected_bytes
  ) order by leased.started_at, leased.token), '[]'::jsonb)
  into v_result
  from leased;
  return v_result;
end;
$$;

create function public.complete_profile_avatar_reconciliation(
  p_operation_token uuid,
  p_worker_id uuid,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.avatar_upload_operations%rowtype;
  v_error_code text := case
    when coalesce(p_error_code, '') ~ '^[A-Z][A-Z0-9_]{1,95}$'
      then p_error_code
    else 'AVATAR_RECONCILE_RETRY'
  end;
begin
  if p_operation_token is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'AVATAR_UPLOAD_OPERATION_INVALID';
  end if;
  select * into v_operation
  from private.avatar_upload_operations operation
  where operation.token = p_operation_token
  for update;
  if p_worker_id is null or not found
    or v_operation.lease_owner is null
    or v_operation.lease_owner is distinct from p_worker_id
    or v_operation.lease_expires_at is null
    or v_operation.lease_expires_at <= statement_timestamp() then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AVATAR_RECONCILE_LEASE_INVALID';
  end if;
  if p_outcome = 'cleaned' then
    if v_operation.state in ('cancel_requested', 'reconcile_required') then
      update private.avatar_upload_operations
      set state = 'aborted', finalized_at = statement_timestamp(),
          artifacts_cleared_at = statement_timestamp(),
          storage_write_lease_expires_at = null,
          lease_owner = null, lease_expires_at = null,
          updated_at = statement_timestamp(), last_error_code = null
      where token = p_operation_token;
    elsif v_operation.state = 'committed' then
      update private.avatar_upload_operations
      set artifacts_cleared_at = statement_timestamp(),
          storage_write_lease_expires_at = null,
          lease_owner = null, lease_expires_at = null,
          updated_at = statement_timestamp(), last_error_code = null
      where token = p_operation_token;
    else
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'AVATAR_RECONCILE_STATE_INVALID';
    end if;
  elsif p_outcome = 'retry' then
    update private.avatar_upload_operations
    set lease_owner = null, lease_expires_at = null,
        next_attempt_at = statement_timestamp() + make_interval(
          secs => least(3600, 30 * greatest(attempt_count, 1))
        ),
        updated_at = statement_timestamp(), last_error_code = v_error_code
    where token = p_operation_token;
  else
    raise exception using errcode = 'check_violation',
      message = 'AVATAR_RECONCILE_OUTCOME_INVALID';
  end if;
  return public.get_profile_avatar_upload_operation(
    v_operation.user_id, p_operation_token
  );
end;
$$;

create function public.prune_terminal_avatar_upload_operations(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_deleted integer;
begin
  with victims as (
    select operation.token
    from private.avatar_upload_operations operation
    where operation.state in ('committed', 'aborted')
      and operation.artifacts_cleared_at is not null
      and operation.finalized_at < statement_timestamp() - interval '24 hours'
    order by operation.finalized_at, operation.token
    limit v_limit
    for update skip locked
  )
  delete from private.avatar_upload_operations operation
  using victims
  where operation.token = victims.token;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on table private.profile_avatar_manifests
  from public, anon, authenticated, service_role;
revoke all on table private.avatar_upload_operations
  from public, anon, authenticated, service_role;
revoke execute on function public.begin_profile_avatar_upload(uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.mark_profile_avatar_staged(uuid,uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.finish_profile_avatar_storage_write(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.finalize_profile_avatar_upload(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.abort_profile_avatar_upload(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.get_profile_avatar_upload_operation(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.claim_profile_avatar_reconciliation(uuid,integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.complete_profile_avatar_reconciliation(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.prune_terminal_avatar_upload_operations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_profile_avatar_upload(uuid,text,integer)
  to service_role;
grant execute on function public.mark_profile_avatar_staged(uuid,uuid,text,integer)
  to service_role;
grant execute on function public.finish_profile_avatar_storage_write(uuid,uuid,text)
  to service_role;
grant execute on function public.finalize_profile_avatar_upload(uuid,uuid)
  to service_role;
grant execute on function public.abort_profile_avatar_upload(uuid,uuid,text)
  to service_role;
grant execute on function public.get_profile_avatar_upload_operation(uuid,uuid)
  to service_role;
grant execute on function public.claim_profile_avatar_reconciliation(uuid,integer)
  to service_role;
grant execute on function public.complete_profile_avatar_reconciliation(uuid,uuid,text,text)
  to service_role;
grant execute on function public.prune_terminal_avatar_upload_operations(integer)
  to service_role;

-- Storage cleanup outlives the Auth/profile FK graph. A user is not purged
-- until a service worker has waited out every upload lease and reported two
-- complete, separated empty-prefix scans.
create table private.account_storage_cleanup_tombstones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  storage_prefix text not null unique,
  state text not null default 'cleanup_pending' check (state in (
    'cleanup_pending', 'sweeping', 'empty_once',
    'storage_cleared', 'post_purge_cleanup',
    'post_purge_empty_once', 'db_purged'
  )),
  requested_at timestamptz not null default statement_timestamp(),
  cleanup_not_before timestamptz not null,
  empty_confirmed_at timestamptz,
  storage_cleared_at timestamptz,
  auth_purged_at timestamptz,
  db_purged_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 10000),
  next_attempt_at timestamptz not null default statement_timestamp(),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,95}$'
  ),
  updated_at timestamptz not null default statement_timestamp(),
  constraint account_storage_cleanup_prefix check (
    storage_prefix = user_id::text || '/'
  ),
  constraint account_storage_cleanup_times check (
    cleanup_not_before >= requested_at
    and (empty_confirmed_at is null or empty_confirmed_at >= cleanup_not_before)
    and (storage_cleared_at is null or storage_cleared_at >= cleanup_not_before)
    and (auth_purged_at is null or auth_purged_at >= storage_cleared_at)
    and (db_purged_at is null or db_purged_at >= auth_purged_at)
  ),
  constraint account_storage_cleanup_state_shape check (
    (state in ('cleanup_pending', 'sweeping')
      and storage_cleared_at is null and db_purged_at is null)
    or (state = 'empty_once' and empty_confirmed_at is not null
      and storage_cleared_at is null and db_purged_at is null)
    or (state = 'storage_cleared' and empty_confirmed_at is not null
      and storage_cleared_at is not null and auth_purged_at is null
      and db_purged_at is null)
    or (state = 'post_purge_cleanup' and empty_confirmed_at is null
      and storage_cleared_at is not null and auth_purged_at is not null
      and db_purged_at is null)
    or (state = 'post_purge_empty_once' and empty_confirmed_at is not null
      and storage_cleared_at is not null and auth_purged_at is not null
      and db_purged_at is null)
    or (state = 'db_purged' and storage_cleared_at is not null
      and auth_purged_at is not null and db_purged_at is not null)
  ),
  constraint account_storage_cleanup_lease_shape check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  )
);

-- Migrations 000-600 could mark an account deletion_pending before any
-- durable Storage-cleanup queue existed. Enqueue every such still-live Auth
-- account so rollout cannot strand an abandoned pre-700 deletion request.
insert into private.account_storage_cleanup_tombstones (
  user_id, storage_prefix, requested_at, cleanup_not_before, next_attempt_at
)
select control.user_id, control.user_id::text || '/',
  statement_timestamp(), statement_timestamp() + interval '15 minutes',
  statement_timestamp() + interval '15 minutes'
from public.account_controls control
join auth.users auth_user on auth_user.id = control.user_id
where control.deletion_pending
  and auth_user.deleted_at is null
on conflict (user_id) do nothing;

create index account_storage_cleanup_claim_idx
  on private.account_storage_cleanup_tombstones (
    next_attempt_at, cleanup_not_before, requested_at, id
  ) where state in (
    'cleanup_pending', 'sweeping', 'empty_once', 'storage_cleared',
    'post_purge_cleanup', 'post_purge_empty_once'
  );
create index account_storage_cleanup_prune_idx
  on private.account_storage_cleanup_tombstones (db_purged_at, id)
  where state = 'db_purged';

create function public.claim_account_storage_cleanup(
  p_worker_id uuid,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_result jsonb;
begin
  if p_worker_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'WORKER_ID_REQUIRED';
  end if;
  with candidates as (
    select tombstone.id
    from private.account_storage_cleanup_tombstones tombstone
    where tombstone.state in (
      'cleanup_pending', 'sweeping', 'empty_once', 'storage_cleared',
      'post_purge_cleanup', 'post_purge_empty_once'
    )
      and tombstone.cleanup_not_before <= statement_timestamp()
      and (
        tombstone.state not in (
          'post_purge_cleanup', 'post_purge_empty_once'
        )
        or tombstone.auth_purged_at
          <= statement_timestamp() - interval '15 minutes'
      )
      and tombstone.next_attempt_at <= statement_timestamp()
      and not exists (
        select 1
        from private.avatar_upload_operations operation
        where operation.user_id = tombstone.user_id
          and operation.storage_write_lease_expires_at
            > statement_timestamp()
      )
      and (tombstone.lease_expires_at is null
        or tombstone.lease_expires_at <= statement_timestamp())
    order by tombstone.next_attempt_at, tombstone.requested_at, tombstone.id
    limit v_limit
    for update skip locked
  ), leased as (
    update private.account_storage_cleanup_tombstones tombstone
    set state = case when tombstone.state = 'cleanup_pending'
          then 'sweeping' else tombstone.state end,
        lease_owner = p_worker_id,
        lease_expires_at = statement_timestamp() + interval '5 minutes',
        attempt_count = least(tombstone.attempt_count + 1, 10000),
        updated_at = statement_timestamp()
    from candidates
    where tombstone.id = candidates.id
    returning tombstone.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'tombstoneId', leased.id,
    'userId', leased.user_id,
    'storagePrefix', leased.storage_prefix,
    'state', leased.state,
    'emptyConfirmedAt', leased.empty_confirmed_at,
    'attemptCount', leased.attempt_count
  ) order by leased.requested_at, leased.id), '[]'::jsonb)
  into v_result
  from leased;
  return v_result;
end;
$$;

create function public.advance_account_storage_cleanup(
  p_tombstone_id uuid,
  p_worker_id uuid,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
  v_error_code text := case
    when coalesce(p_error_code, '') ~ '^[A-Z][A-Z0-9_]{1,95}$'
      then p_error_code
    else 'STORAGE_CLEANUP_RETRY'
  end;
begin
  select * into v_tombstone
  from private.account_storage_cleanup_tombstones tombstone
  where tombstone.id = p_tombstone_id
  for update;
  if p_worker_id is null or not found
    or v_tombstone.lease_owner is null
    or v_tombstone.lease_owner is distinct from p_worker_id
    or v_tombstone.lease_expires_at is null
    or v_tombstone.lease_expires_at <= statement_timestamp() then
    raise exception using errcode = 'insufficient_privilege',
      message = 'STORAGE_CLEANUP_LEASE_INVALID';
  end if;
  if v_tombstone.state = 'db_purged' then
    return jsonb_build_object(
      'tombstoneId', v_tombstone.id, 'state', v_tombstone.state
    );
  end if;
  if v_tombstone.state in ('post_purge_cleanup', 'post_purge_empty_once') then
    if p_outcome = 'empty' then
      if v_tombstone.state = 'post_purge_empty_once'
        and v_tombstone.empty_confirmed_at
          <= statement_timestamp() - interval '2 minutes' then
        update private.account_storage_cleanup_tombstones
        set state = 'db_purged', db_purged_at = statement_timestamp(),
            lease_owner = null, lease_expires_at = null,
            updated_at = statement_timestamp(), last_error_code = null
        where id = p_tombstone_id;
      else
        update private.account_storage_cleanup_tombstones
        set state = 'post_purge_empty_once',
            empty_confirmed_at = statement_timestamp(),
            next_attempt_at = statement_timestamp() + interval '2 minutes',
            lease_owner = null, lease_expires_at = null,
            updated_at = statement_timestamp(), last_error_code = null
        where id = p_tombstone_id;
      end if;
    elsif p_outcome in ('nonempty', 'retry') then
      update private.account_storage_cleanup_tombstones
      set state = 'post_purge_cleanup', empty_confirmed_at = null,
          lease_owner = null, lease_expires_at = null,
          next_attempt_at = statement_timestamp() + make_interval(
            secs => least(3600, 30 * greatest(attempt_count, 1))
          ),
          updated_at = statement_timestamp(), last_error_code = v_error_code
      where id = p_tombstone_id;
    else
      raise exception using errcode = 'check_violation',
        message = 'STORAGE_CLEANUP_OUTCOME_INVALID';
    end if;
    select * into v_tombstone
    from private.account_storage_cleanup_tombstones
    where id = p_tombstone_id;
    return jsonb_build_object(
      'tombstoneId', v_tombstone.id,
      'state', v_tombstone.state,
      'nextAttemptAt', v_tombstone.next_attempt_at
    );
  end if;
  if v_tombstone.state = 'storage_cleared' then
    if p_outcome is distinct from 'retry' then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'STORAGE_CLEANUP_OUTCOME_INVALID';
    end if;
    update private.account_storage_cleanup_tombstones
    set lease_owner = null, lease_expires_at = null,
        next_attempt_at = statement_timestamp() + make_interval(
          secs => least(3600, 30 * greatest(attempt_count, 1))
        ),
        updated_at = statement_timestamp(), last_error_code = v_error_code
    where id = p_tombstone_id;
    return jsonb_build_object(
      'tombstoneId', v_tombstone.id,
      'state', 'storage_cleared',
      'nextAttemptAt', statement_timestamp() + make_interval(
        secs => least(3600, 30 * greatest(v_tombstone.attempt_count, 1))
      )
    );
  end if;

  if p_outcome = 'empty' then
    if v_tombstone.state = 'empty_once'
      and v_tombstone.empty_confirmed_at
        <= statement_timestamp() - interval '2 minutes' then
      update private.account_storage_cleanup_tombstones
      set state = 'storage_cleared', storage_cleared_at = statement_timestamp(),
          lease_owner = null, lease_expires_at = null,
          updated_at = statement_timestamp(), last_error_code = null
      where id = p_tombstone_id;
      update private.avatar_upload_operations
      set state = case when state = 'committed' then state else 'aborted' end,
          finalized_at = coalesce(finalized_at, statement_timestamp()),
          artifacts_cleared_at = statement_timestamp(),
          lease_owner = null, lease_expires_at = null,
          updated_at = statement_timestamp(), last_error_code = null
      where user_id = v_tombstone.user_id;
    else
      update private.account_storage_cleanup_tombstones
      set state = 'empty_once',
          empty_confirmed_at = statement_timestamp(),
          next_attempt_at = statement_timestamp() + interval '2 minutes',
          lease_owner = null, lease_expires_at = null,
          updated_at = statement_timestamp(), last_error_code = null
      where id = p_tombstone_id;
    end if;
  elsif p_outcome in ('nonempty', 'retry') then
    update private.account_storage_cleanup_tombstones
    set state = 'cleanup_pending', empty_confirmed_at = null,
        lease_owner = null, lease_expires_at = null,
        next_attempt_at = statement_timestamp() + make_interval(
          secs => least(3600, 30 * greatest(attempt_count, 1))
        ),
        updated_at = statement_timestamp(), last_error_code = v_error_code
    where id = p_tombstone_id;
  else
    raise exception using errcode = 'check_violation',
      message = 'STORAGE_CLEANUP_OUTCOME_INVALID';
  end if;
  select * into v_tombstone
  from private.account_storage_cleanup_tombstones
  where id = p_tombstone_id;
  return jsonb_build_object(
    'tombstoneId', v_tombstone.id,
    'state', v_tombstone.state,
    'nextAttemptAt', v_tombstone.next_attempt_at
  );
end;
$$;

create function public.prune_account_storage_cleanup_tombstones(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_deleted integer;
begin
  with victims as (
    select tombstone.id
    from private.account_storage_cleanup_tombstones tombstone
    where tombstone.state = 'db_purged'
      and tombstone.db_purged_at < statement_timestamp() - interval '90 days'
    order by tombstone.db_purged_at, tombstone.id
    limit v_limit
    for update skip locked
  )
  delete from private.account_storage_cleanup_tombstones tombstone
  using victims
  where tombstone.id = victims.id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

create function private.guard_auth_user_avatar_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    coalesce(
      current_setting('safetyhub.storage_purge_user_id', true), ''
    ) = old.id::text
    and exists (
      select 1
      from private.account_storage_cleanup_tombstones tombstone
      where tombstone.user_id = old.id
        and tombstone.state = 'storage_cleared'
    )
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_STORAGE_CLEANUP_PENDING';
  end if;
  return old;
end;
$$;

drop trigger if exists auth_users_avatar_cleanup_guard on auth.users;
create trigger auth_users_avatar_cleanup_guard
before delete on auth.users
for each row execute function private.guard_auth_user_avatar_cleanup();

revoke all on table private.account_storage_cleanup_tombstones
  from public, anon, authenticated, service_role;
revoke all on function private.guard_auth_user_avatar_cleanup()
  from public, anon, authenticated, service_role;
revoke execute on function public.claim_account_storage_cleanup(uuid,integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.advance_account_storage_cleanup(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.prune_account_storage_cleanup_tombstones(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_account_storage_cleanup(uuid,integer)
  to service_role;
grant execute on function public.advance_account_storage_cleanup(uuid,uuid,text,text)
  to service_role;
grant execute on function public.prune_account_storage_cleanup_tombstones(integer)
  to service_role;

create or replace function public.get_public_certificate(p_certificate_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', certificate.id,
    'certificateNumber', certificate.certificate_number,
    'fullName', certificate.full_name,
    'organization', certificate.organization,
    'testTitle', certificate.test_title,
    'score', certificate.score,
    'total', certificate.total,
    'issuedAt', certificate.issued_at,
    'revokedAt', certificate.revoked_at,
    'revokeReason', certificate.revoke_reason
  )
  from public.certificates certificate
  join public.account_controls control on control.user_id = certificate.user_id
  join auth.users auth_user on auth_user.id = certificate.user_id
  where certificate.id = p_certificate_id
    and auth_user.deleted_at is null
    and control.status = 'active'
    and not control.deletion_pending;
$$;

revoke execute on function public.get_public_certificate(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_certificate(uuid) to service_role;

-- These owner/account read models must not remain usable after suspension or
-- once account deletion begins. The dashboard can still call its private
-- dependency as function owner; browser roles no longer execute the wider
-- attestation helper directly.
revoke execute on function public.get_profile_attestations()
  from public, anon, authenticated, service_role;

create or replace function public.search_profile_organizations(
  p_query text,
  p_limit integer default 8
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_result text[];
begin
  v_user_id := private.require_active_user();
  select coalesce(
    array_agg(candidate.organization
      order by candidate.frequency desc, candidate.organization),
    '{}'::text[]
  )
  into v_result
  from (
    select min(profile.organization) as organization, count(*) as frequency
    from public.profiles profile
    where nullif(private.normalized_lookup_key(profile.organization), '') is not null
      and private.normalized_lookup_key(profile.organization)
        like '%' || private.normalized_lookup_key(p_query) || '%'
    group by private.normalized_lookup_key(profile.organization)
    order by count(*) desc, min(profile.organization)
    limit least(greatest(coalesce(p_limit, 8), 1), 20)
  ) candidate;
  return v_result;
end;
$$;

create or replace function public.get_user_identity(p_target_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_user_id uuid := coalesce(p_target_id, v_actor_id);
  v_identity public.verified_identities%rowtype;
begin
  if v_user_id is distinct from v_actor_id then
    perform private.require_capability('identity.read');
  end if;
  select * into v_identity
  from public.verified_identities
  where user_id = v_user_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'userId', v_identity.user_id,
    'status', v_identity.status,
    'version', v_identity.version,
    'name', v_identity.name,
    'surname', v_identity.surname,
    'job', v_identity.job,
    'organization', v_identity.organization,
    'verifiedAt', v_identity.verified_at,
    'revokedAt', v_identity.revoked_at,
    'revokeReason', v_identity.revoke_reason
  );
end;
$$;

revoke execute on function public.search_profile_organizations(text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.search_profile_organizations(text,integer)
  to authenticated;
revoke execute on function public.get_user_identity(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_user_identity(uuid) to authenticated;

create or replace function public.update_profile(
  p_name text, p_surname text, p_job text, p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('profile.update');
  begin
    v_result := private.update_profile_unmetered(
      p_name, p_surname, p_job, p_organization
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.complete_profile_onboarding(
  p_name text, p_surname text, p_job text, p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('profile.update');
  begin
    v_user_id := private.require_active_user();
    if not exists (
      select 1
      from public.profiles profile
      join private.profile_avatar_manifests manifest on manifest.user_id = profile.id
      where profile.id = v_user_id
        and profile.avatar_updated_at is not null
        and (
          (
            not manifest.legacy_imported
            and manifest.object_key =
              v_user_id::text || '/objects/' || manifest.operation_token::text || '.webp'
          )
          or (
            manifest.legacy_imported
            and manifest.object_key = v_user_id::text || '/avatar.webp'
          )
        )
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'AVATAR_REQUIRED';
    end if;
    v_result := private.update_profile_unmetered(
      p_name, p_surname, p_job, p_organization
    );
    update public.profiles
    set onboarding_completed_at = coalesce(
      onboarding_completed_at, statement_timestamp()
    )
    where id = v_user_id;
    return private.ensure_rpc_payload(
      v_result || jsonb_build_object('completed', true)
    );
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.accept_current_legal_documents(
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
  v_result jsonb;
begin
  perform private.enforce_actor_quota('legal.accept');
  begin
    v_result := private.accept_current_legal_documents_unmetered(
      p_privacy_version, p_privacy_body_revision,
      p_terms_version, p_terms_body_revision
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.save_article_draft(
  p_article_id uuid,
  p_original_slug text,
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_review_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_result := private.save_article_draft_unmetered(
      p_article_id, p_original_slug, p_slug, p_title, p_description,
      p_cover_image, p_blocks, p_review_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.set_article_status(
  p_article_id uuid, p_status public.article_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_result := private.set_article_status_unmetered(p_article_id, p_status);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.save_test_content(
  p_actor_id uuid,
  p_test_id uuid,
  p_slug text,
  p_title text,
  p_description text,
  p_duration_minutes integer,
  p_questions jsonb,
  p_publish boolean,
  p_review_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_result := private.save_test_content_unmetered(
      p_actor_id, p_test_id, p_slug, p_title, p_description,
      p_duration_minutes, p_questions, p_publish, p_review_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.set_test_status(
  p_actor_id uuid, p_test_id uuid, p_status public.test_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_result := private.set_test_status_unmetered(
      p_actor_id, p_test_id, p_status
    );
    insert into public.admin_audit_log (
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      (select auth.uid()), 'test.status_changed', 'test', p_test_id::text,
      jsonb_build_object('status', p_status)
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.start_test_attempt(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_detail text;
begin
  perform private.enforce_actor_quota('attempt.start');
  begin
    v_result := private.start_test_attempt_unmetered(p_test_slug);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return private.rpc_error_envelope(sqlstate, sqlerrm, v_detail);
  end;
end;
$$;

create or replace function public.complete_test_attempt(
  p_attempt_id uuid, p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('attempt.complete');
  begin
    v_result := private.complete_test_attempt_unmetered(
      p_attempt_id, p_answers
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.verify_user_identity(
  p_target_id uuid,
  p_name text,
  p_surname text,
  p_job text,
  p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.identity.mutate');
  begin
    v_result := private.verify_user_identity_unmetered(
      p_target_id, p_name, p_surname, p_job, p_organization
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.revoke_user_identity(
  p_target_id uuid, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_result jsonb;
  v_batch_id uuid;
begin
  perform private.enforce_actor_quota('admin.identity.mutate');
  begin
    v_actor_id := private.require_capability('identity.manage');
    v_batch_id := gen_random_uuid();
    perform pg_advisory_xact_lock(hashtextextended(p_target_id::text, 0));
    v_result := private.revoke_user_identity_unmetered(
      p_target_id, p_reason
    );
    with revoked as (
      update public.certificates
      set revoked_at = statement_timestamp(),
          revoked_by = v_actor_id,
          revoke_reason = 'Данные пользователя отозваны'
      where user_id = p_target_id and revoked_at is null
      returning id, certificate_number
    )
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      after_data, reason, batch_id
    )
    select
      v_actor_id, p_target_id, 'certificate.revoked', 'certificate',
      revoked.id::text,
      jsonb_build_object('certificateNumber', revoked.certificate_number),
      'Данные пользователя отозваны', v_batch_id
    from revoked;
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.confirm_admin_identities(p_user_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  begin
    v_result := private.sanitize_bulk_mutation_result(
      private.confirm_admin_identities_unmetered(p_user_ids)
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.bulk_update_participants(
  p_user_ids uuid[], p_field text, p_value text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  begin
    v_result := private.sanitize_bulk_mutation_result(
      private.bulk_update_participants_unmetered(
        p_user_ids, p_field, p_value
      )
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.issue_certificates(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  begin
    v_result := private.sanitize_bulk_mutation_result(
      private.issue_certificates_unmetered(p_attestation_ids)
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.revoke_certificates(
  p_certificate_ids uuid[], p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.certificate.revoke');
  begin
    v_result := private.sanitize_bulk_mutation_result(
      private.revoke_certificates_unmetered(
        p_certificate_ids, p_reason
      )
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.revoke_certificate(
  p_certificate_id uuid, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.revoke_certificates(
    array[p_certificate_id], p_reason
  );
  if jsonb_typeof(v_result) = 'object'
    and v_result ? '__safetyhubRpcError' then
    return v_result;
  end if;
  return v_result -> 0;
end;
$$;

create or replace function public.update_site_settings(
  p_phone_e164 text,
  p_phone_display text,
  p_whatsapp_e164 text,
  p_whatsapp_same_as_phone boolean,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('site.settings.update');
  begin
    v_result := private.update_site_settings_unmetered(
      p_phone_e164, p_phone_display, p_whatsapp_e164,
      p_whatsapp_same_as_phone, p_expected_version
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.prepare_user_invite(
  p_email text,
  p_name text,
  p_surname text,
  p_job text,
  p_requested_role public.app_role,
  p_password_ticket text,
  p_redirect_origin text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.invite');
  begin
    perform private.lock_auth_admin_outbox();
    if p_correlation_id is null
      or p_requested_role is null
      or p_email is null
      or char_length(v_email) not between 3 and 320
      or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
      or p_name is null
      or char_length(private.normalize_profile_text(p_name)) not between 1 and 80
      or p_surname is null
      or char_length(private.normalize_profile_text(p_surname)) not between 1 and 80
      or p_job is null
      or char_length(private.normalize_profile_text(p_job)) not between 1 and 160
      or p_requested_role = 'superadmin'
      or p_password_ticket is null
      or char_length(p_password_ticket) not between 32 and 128
      or p_redirect_origin is null
      or char_length(p_redirect_origin) not between 8 and 2048 then
      raise exception using errcode = 'check_violation',
        message = 'INVITE_INVALID';
    end if;
    if exists (
      select 1
      from auth.users auth_user
      join public.account_controls control on control.user_id = auth_user.id
      where auth_user.deleted_at is null
        and lower(btrim(auth_user.email)) = v_email
        and control.deletion_pending
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ACCOUNT_PURGE_NOT_READY';
    end if;
    if exists (
      select 1
      from private.auth_admin_outbox operation
      where operation.operation_type = 'invite'
        and operation.state in ('prepared', 'external_succeeded', 'retryable')
        and lower(btrim(operation.payload ->> 'email')) = v_email
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS';
    end if;
    v_result := private.prepare_user_invite_unmetered(
      p_email, p_name, p_surname, p_job, p_requested_role,
      p_password_ticket, p_redirect_origin, p_correlation_id,
      p_request_id, p_ip_hash, p_user_agent
    );
    update private.auth_admin_outbox
    set payload = payload || jsonb_build_object(
      '_audit',
      jsonb_strip_nulls(jsonb_build_object(
        'requestId', p_request_id,
        'ipHash', p_ip_hash,
        'userAgent', left(p_user_agent, 256)
      ))
    )
    where id = (v_result ->> 'operationId')::uuid;
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.request_account_suspension_confirmed(
  p_target_id uuid,
  p_suspended boolean,
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_status public.account_status;
  v_deletion_pending boolean;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.suspend');
  begin
    if p_target_id is null
      or p_suspended is null
      or p_correlation_id is null
      or p_reason is null
      or char_length(private.normalize_profile_text(p_reason)) not between 10 and 500 then
      raise exception using errcode = 'check_violation',
        message = 'SUSPENSION_INVALID';
    end if;
    perform private.lock_auth_admin_outbox();
    perform private.lock_active_superadmin_invariant();
    v_actor_id := private.require_capability('user.suspend');
    if exists (
      select 1 from public.user_roles target_role
      where target_role.user_id = p_target_id
        and target_role.role in ('admin', 'superadmin')
    ) and not exists (
      select 1 from public.user_roles actor_role
      where actor_role.user_id = v_actor_id
        and actor_role.role = 'superadmin'
    ) then
      raise exception using errcode = 'insufficient_privilege',
        message = 'SUPERADMIN_REQUIRED';
    end if;
    select control.status, control.deletion_pending
    into v_status, v_deletion_pending
    from public.account_controls control
    where control.user_id = p_target_id
    for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
    end if;
    if v_deletion_pending then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ACCOUNT_PURGE_NOT_READY';
    end if;
    if private.has_pending_auth_admin_operation(p_target_id, null) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS';
    end if;
    if not p_suspended and v_status <> 'suspended' then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ACCOUNT_NOT_SUSPENDED';
    end if;
    if p_suspended then
      update public.account_controls
      set status = 'suspended', suspended_at = statement_timestamp(),
          suspended_by = v_actor_id,
          suspension_reason = private.normalize_profile_text(p_reason)
      where user_id = p_target_id;
    end if;
    v_result := private.request_account_suspension_confirmed_unmetered(
      p_target_id, p_suspended, p_reason, p_correlation_id,
      p_request_id, p_ip_hash, p_user_agent
    );
    update private.auth_admin_outbox
    set payload = payload || jsonb_build_object(
      '_audit',
      jsonb_strip_nulls(jsonb_build_object(
        'requestId', p_request_id,
        'ipHash', p_ip_hash,
        'userAgent', left(p_user_agent, 256)
      ))
    )
    where id = (v_result ->> 'operationId')::uuid;
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.manage_user_role_confirmed(
  p_target_id uuid,
  p_role public.app_role,
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.access.mutate');
  begin
    perform private.lock_active_superadmin_invariant();
    v_result := private.manage_user_role_confirmed_unmetered(
      p_target_id, p_role, p_reason, p_correlation_id,
      p_request_id, p_ip_hash, p_user_agent
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- Change the only non-JSON metered mutation to JSON. A successful text[] is
-- represented by the same JSON array that PostgREST already returned; errors
-- can now use the common reserved envelope.
alter function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) rename to set_user_capabilities_confirmed_rollback_prone;
alter function public.set_user_capabilities_confirmed_rollback_prone(
  uuid,text[],text,uuid,text,text,text
) set schema private;
revoke all on function private.set_user_capabilities_confirmed_rollback_prone(
  uuid,text[],text,uuid,text,text,text
) from public, anon, authenticated, service_role;

create function public.set_user_capabilities_confirmed(
  p_target_id uuid,
  p_capabilities text[],
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.access.mutate');
  begin
    v_result := to_jsonb(private.set_user_capabilities_confirmed_unmetered(
      p_target_id, p_capabilities, p_reason, p_correlation_id,
      p_request_id, p_ip_hash, p_user_agent
    ));
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke execute on function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) to authenticated;

create or replace function public.claim_auth_admin_operation_confirmed(
  p_operation_id uuid,
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_target_user_id uuid;
  v_operation private.auth_admin_outbox%rowtype;
  v_token text;
  v_recovery_count integer;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.reconcile');
  begin
    perform private.lock_auth_admin_outbox();
    v_actor_id := private.require_capability('capability.manage');
    if not exists (
      select 1 from public.user_roles actor_role
      where actor_role.user_id = v_actor_id and actor_role.role = 'superadmin'
    ) then
      raise exception using errcode = 'insufficient_privilege',
        message = 'SUPERADMIN_REQUIRED';
    end if;
    select * into v_operation
    from private.auth_admin_outbox operation
    where operation.id = p_operation_id
      and operation.state in ('prepared', 'external_succeeded', 'retryable')
    for update;
    if not found then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'OUTBOX_NOT_CLAIMABLE';
    end if;
    if v_operation.processing_lease_expires_at > statement_timestamp() then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'OUTBOX_ALREADY_CLAIMED';
    end if;
    perform private.lock_active_superadmin_invariant();

    v_target_user_id := v_operation.target_id;
    if v_operation.operation_type = 'invite' and v_target_user_id is null then
      select count(*), (array_agg(auth_user.id order by auth_user.id))[1]
      into v_recovery_count, v_target_user_id
      from auth.users auth_user
      where auth_user.deleted_at is null
        and lower(btrim(auth_user.email)) =
          lower(btrim(v_operation.payload ->> 'email'))
        and auth_user.raw_user_meta_data ->> 'safetyhubInviteCorrelation' =
          v_operation.payload ->> 'inviteCorrelation';
      if v_recovery_count > 1 then
        raise exception using errcode = 'cardinality_violation',
          message = 'OUTBOX_INVITE_RECOVERY_AMBIGUOUS';
      end if;
    elsif v_target_user_id is null
      and v_operation.operation_type in ('suspend', 'restore')
      and (v_operation.payload ->> 'targetId') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_target_user_id := (v_operation.payload ->> 'targetId')::uuid;
    end if;

    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    update private.auth_admin_outbox
    set target_id = coalesce(v_target_user_id, target_id),
        completion_token_hash = encode(
          extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'
        ),
        processing_lease_expires_at = statement_timestamp() + interval '5 minutes',
        attempts = attempts + 1,
        updated_at = statement_timestamp()
    where id = p_operation_id;
    v_result := jsonb_build_object(
      'operationId', v_operation.id,
      'completionToken', v_token,
      'operationType', v_operation.operation_type,
      'state', v_operation.state,
      'externalTargetId', v_target_user_id,
      'payload', v_operation.payload
    );
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id, reason,
      correlation_id, request_id, ip_hash, user_agent
    ) values (
      v_actor_id, v_target_user_id, 'auth_operation.claimed', 'auth_admin_operation',
      p_operation_id::text, private.normalize_profile_text(p_reason),
      coalesce(p_correlation_id, gen_random_uuid()), p_request_id,
      p_ip_hash, left(p_user_agent, 256)
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- Service-side Auth effects are finalized under the same global lock as
-- prepare, claim and purge. Suspension is fail-closed: prepare already made
-- the local account suspended, and no failure transition reactivates it.
create or replace function public.advance_auth_admin_operation(
  p_operation_id uuid,
  p_completion_token text,
  p_state text,
  p_external_target_id uuid default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.auth_admin_outbox%rowtype;
  v_expected text := encode(
    extensions.digest(convert_to(coalesce(p_completion_token, ''), 'utf8'), 'sha256'),
    'hex'
  );
  v_target_id uuid;
  v_audit_target_id uuid;
  v_audit jsonb;
  v_error_category text := case
    when coalesce(p_error, '') ~ '^[A-Z][A-Z0-9_]{1,95}$' then p_error
    else 'AUTH_ADMIN_UNKNOWN'
  end;
  v_sanitized_payload jsonb;
begin
  perform private.lock_auth_admin_outbox();
  perform private.lock_active_superadmin_invariant();
  select * into v_operation
  from private.auth_admin_outbox operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.completion_token_hash <> v_expected then
    raise exception using errcode = 'insufficient_privilege',
      message = 'OUTBOX_TOKEN_INVALID';
  end if;
  if v_operation.state in ('committed', 'rolled_back', 'failed') then
    if v_operation.state = p_state then
      return jsonb_build_object('operationId', p_operation_id, 'state', p_state);
    end if;
    raise exception using errcode = 'check_violation',
      message = 'OUTBOX_TRANSITION_INVALID';
  end if;
  if v_operation.processing_lease_expires_at is null
    or v_operation.processing_lease_expires_at <= statement_timestamp() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'OUTBOX_LEASE_EXPIRED';
  end if;
  if p_state not in (
    'external_succeeded', 'committed', 'retryable', 'rolled_back', 'failed'
  ) or (p_state = 'external_succeeded'
    and v_operation.state not in ('prepared', 'retryable', 'external_succeeded'))
    or (p_state = 'committed' and v_operation.state <> 'external_succeeded') then
    raise exception using errcode = 'check_violation',
      message = 'OUTBOX_TRANSITION_INVALID';
  end if;

  if v_operation.operation_type in ('suspend', 'restore') then
    if coalesce(v_operation.payload ->> 'targetId', '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or v_operation.target_id is null
      or v_operation.target_id::text
        is distinct from v_operation.payload ->> 'targetId'
      or (p_external_target_id is not null
        and p_external_target_id <> v_operation.target_id) then
      raise exception using errcode = 'check_violation',
        message = 'OUTBOX_TARGET_MISMATCH';
    end if;
    v_target_id := v_operation.target_id;
  else
    if v_operation.target_id is not null
      and p_external_target_id is not null
      and p_external_target_id <> v_operation.target_id then
      raise exception using errcode = 'check_violation',
        message = 'OUTBOX_TARGET_MISMATCH';
    end if;
    v_target_id := coalesce(v_operation.target_id, p_external_target_id);
  end if;
  if p_state in ('external_succeeded', 'committed') and v_target_id is null then
    raise exception using errcode = 'check_violation',
      message = 'OUTBOX_TARGET_REQUIRED';
  end if;
  if p_state = 'external_succeeded' then
    update private.auth_admin_outbox
    set state = 'external_succeeded', target_id = v_target_id,
        attempts = attempts + 1, last_error = null,
        updated_at = statement_timestamp()
    where id = p_operation_id;
    return jsonb_build_object(
      'operationId', p_operation_id, 'state', 'external_succeeded'
    );
  end if;
  if p_state = 'retryable' then
    update private.auth_admin_outbox
    set state = 'retryable', target_id = coalesce(v_target_id, target_id),
        attempts = attempts + 1, last_error = v_error_category,
        processing_lease_expires_at = null,
        updated_at = statement_timestamp()
    where id = p_operation_id;
    return jsonb_build_object('operationId', p_operation_id, 'state', 'retryable');
  end if;

  v_audit := coalesce(v_operation.payload -> '_audit', '{}'::jsonb);
  if p_state = 'committed' then
    if v_operation.operation_type = 'invite' then
      if not exists (
        select 1
        from auth.users auth_user
        where auth_user.id = v_target_id
          and auth_user.deleted_at is null
          and lower(btrim(auth_user.email)) =
            lower(btrim(v_operation.payload ->> 'email'))
          and auth_user.raw_user_meta_data ->> 'safetyhubInviteCorrelation' =
            v_operation.payload ->> 'inviteCorrelation'
      ) then
        raise exception using errcode = 'object_not_in_prerequisite_state',
          message = 'OUTBOX_INVITE_TARGET_MISMATCH';
      end if;
      if (v_operation.payload ->> 'requestedRole') = 'admin'
        and not exists (
          select 1 from public.user_roles actor_role
          where actor_role.user_id = v_operation.actor_user_id
            and actor_role.role = 'superadmin'
        ) then
        raise exception using errcode = 'insufficient_privilege',
          message = 'SUPERADMIN_REQUIRED';
      end if;
      update public.profiles
      set name = v_operation.payload ->> 'name',
          surname = v_operation.payload ->> 'surname',
          job = v_operation.payload ->> 'job'
      where id = v_target_id;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
      end if;
      update public.user_roles
      set role = (v_operation.payload ->> 'requestedRole')::public.app_role,
          created_by = v_operation.actor_user_id
      where user_id = v_target_id;
    elsif v_operation.operation_type in ('suspend', 'restore') then
      if exists (
        select 1 from public.user_roles target_role
        where target_role.user_id = v_target_id
          and target_role.role in ('admin', 'superadmin')
      ) and not exists (
        select 1 from public.user_roles actor_role
        where actor_role.user_id = v_operation.actor_user_id
          and actor_role.role = 'superadmin'
      ) then
        raise exception using errcode = 'insufficient_privilege',
          message = 'SUPERADMIN_REQUIRED';
      end if;
      update public.account_controls
      set status = case when v_operation.operation_type = 'suspend'
            then 'suspended'::public.account_status
            else 'active'::public.account_status end,
          suspended_at = case when v_operation.operation_type = 'suspend'
            then coalesce(suspended_at, statement_timestamp()) else null end,
          suspended_by = case when v_operation.operation_type = 'suspend'
            then v_operation.actor_user_id else null end,
          suspension_reason = case when v_operation.operation_type = 'suspend'
            then v_operation.payload ->> 'reason' else null end
      where user_id = v_target_id and not deletion_pending;
      if not found then
        raise exception using errcode = 'object_not_in_prerequisite_state',
          message = 'ACCOUNT_PURGE_NOT_READY';
      end if;
    else
      raise exception using errcode = 'check_violation',
        message = 'OUTBOX_OPERATION_INVALID';
    end if;

    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      after_data, reason, correlation_id, request_id, ip_hash, user_agent
    ) select
      v_operation.actor_user_id,
      v_target_id,
      case v_operation.operation_type
        when 'invite' then 'user.invited'
        when 'suspend' then 'account.suspended'
        else 'account.restored'
      end,
      'user', v_target_id::text,
      jsonb_build_object('operationId', v_operation.id),
      v_operation.payload ->> 'reason', v_operation.correlation_id,
      v_audit ->> 'requestId', v_audit ->> 'ipHash',
      left(v_audit ->> 'userAgent', 256)
    where not exists (
      select 1 from public.admin_audit_log audit
      where audit.action = case v_operation.operation_type
          when 'invite' then 'user.invited'
          when 'suspend' then 'account.suspended'
          else 'account.restored' end
        and audit.after_data ->> 'operationId' = v_operation.id::text
    );
  elsif v_operation.operation_type in ('suspend', 'restore') then
    -- Both failure outcomes remain locally suspended. Restore may reactivate
    -- only after the external unban and a committed transition.
    update public.account_controls
    set status = 'suspended'
    where user_id = coalesce(v_target_id, v_operation.target_id);
  end if;

  select case when exists (
    select 1 from auth.users auth_user where auth_user.id = v_target_id
  ) then v_target_id else null end
  into v_audit_target_id;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    after_data, correlation_id, request_id, ip_hash, user_agent
  ) select
    v_operation.actor_user_id, v_audit_target_id,
    'auth_operation.' || p_state, 'auth_admin_operation',
    v_operation.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'operationId', v_operation.id,
      'state', p_state,
      'operationType', v_operation.operation_type,
      'errorCategory', case when p_state = 'committed'
        then null else v_error_category end
    )),
    v_operation.correlation_id, v_audit ->> 'requestId',
    v_audit ->> 'ipHash', left(v_audit ->> 'userAgent', 256)
  where not exists (
    select 1 from public.admin_audit_log audit
    where audit.action = 'auth_operation.' || p_state
      and audit.target_type = 'auth_admin_operation'
      and audit.target_id = v_operation.id::text
  );

  v_sanitized_payload := jsonb_strip_nulls(jsonb_build_object(
    'targetId', coalesce(v_target_id, v_operation.target_id),
    'requestedRole', v_operation.payload ->> 'requestedRole'
  ));
  update private.auth_admin_outbox
  set state = p_state, target_id = coalesce(v_target_id, target_id),
      payload = v_sanitized_payload,
      last_error = case when p_state = 'committed'
        then null else v_error_category end,
      attempts = attempts + case when p_state = 'committed' then 0 else 1 end,
      processing_lease_expires_at = null,
      updated_at = statement_timestamp()
  where id = p_operation_id;
  return jsonb_build_object('operationId', p_operation_id, 'state', p_state);
end;
$$;

revoke execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  to service_role;

create function public.prune_terminal_auth_admin_outbox(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_deleted integer;
begin
  perform private.lock_auth_admin_outbox();
  with victims as (
    select operation.id
    from private.auth_admin_outbox operation
    where operation.state in ('committed', 'rolled_back', 'failed')
      and operation.updated_at < statement_timestamp() - interval '90 days'
    order by operation.updated_at, operation.id
    limit v_limit
    for update skip locked
  )
  delete from private.auth_admin_outbox operation
  using victims
  where operation.id = victims.id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke execute on function public.prune_terminal_auth_admin_outbox(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_terminal_auth_admin_outbox(integer)
  to service_role;

-- Audit records linked to a user's private outbox operations must disappear
-- with that account even when an older claim row omitted target_user_id. The
-- purge GUC carries both the user and the narrowly scoped operation IDs into
-- the append-only trigger; arbitrary audit deletion remains forbidden.
create or replace function private.guard_admin_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purge_actor text := coalesce(
    current_setting('safetyhub.purge_actor_id', true), ''
  );
  v_purge_operation_ids text[] := string_to_array(
    coalesce(current_setting('safetyhub.purge_operation_ids', true), ''), ','
  );
begin
  if tg_op = 'DELETE' and v_purge_actor <> ''
    and (
      old.actor_user_id::text = v_purge_actor
      or old.target_user_id::text = v_purge_actor
      or (
        old.target_type = 'auth_admin_operation'
        and old.target_id = any(v_purge_operation_ids)
      )
    ) then
    return old;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'ADMIN_AUDIT_LOG_IMMUTABLE';
end;
$$;

revoke all on function private.guard_admin_audit_log()
  from public, anon, authenticated, service_role;
-- This trigger helper was introduced after the baseline's blanket private
-- ACL reset. Close its preserved PostgreSQL default EXECUTE privilege too.
revoke all on function private.guard_attestation_best_attempt()
  from public, anon, authenticated, service_role;

-- Account purge resolves legacy/outbox-linked audit rows by exact operation ID.
-- Audit retention is intentionally unbounded, so this partial index prevents a
-- privacy deletion from devolving into a full immutable-audit scan.
create index admin_audit_auth_operation_target_idx
  on public.admin_audit_log (target_id)
  where target_type = 'auth_admin_operation';

create or replace function public.begin_user_account_purge(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_pending boolean;
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'USER_ID_REQUIRED';
  end if;
  perform private.lock_auth_admin_outbox();
  perform private.lock_active_superadmin_invariant();
  perform private.lock_signup_legal_operations();
  select lower(btrim(auth_user.email)) into v_email
  from auth.users auth_user
  where auth_user.id = p_target_id and auth_user.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object(
      'userId', p_target_id, 'exists', false, 'pending', false
    );
  end if;
  select control.deletion_pending into v_pending
  from public.account_controls control
  where control.user_id = p_target_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  if private.has_pending_auth_admin_operation(p_target_id, v_email) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS';
  end if;
  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id;

  insert into private.account_storage_cleanup_tombstones (
    user_id, storage_prefix, cleanup_not_before, next_attempt_at
  ) values (
    p_target_id, p_target_id::text || '/',
    statement_timestamp() + interval '15 minutes',
    statement_timestamp() + interval '15 minutes'
  ) on conflict (user_id) do nothing;
  select * into v_tombstone
  from private.account_storage_cleanup_tombstones tombstone
  where tombstone.user_id = p_target_id
  for update;
  update private.avatar_upload_operations
  set state = 'cancel_requested', updated_at = statement_timestamp(),
      next_attempt_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      last_error_code = 'ACCOUNT_DELETION_REQUESTED'
  where user_id = p_target_id
    and state in ('prepared', 'staged', 'reconcile_required');
  return jsonb_build_object(
    'userId', p_target_id,
    'exists', true,
    'pending', true,
    'tombstoneId', v_tombstone.id,
    'state', v_tombstone.state,
    'cleanupNotBefore', v_tombstone.cleanup_not_before
  );
end;
$$;

create or replace function public.purge_user_account(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
  v_email text;
  v_operation_ids uuid[];
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'USER_ID_REQUIRED';
  end if;
  perform private.lock_auth_admin_outbox();
  perform private.lock_active_superadmin_invariant();
  perform private.lock_signup_legal_operations();
  select lower(btrim(auth_user.email)) into v_email
  from auth.users auth_user
  where auth_user.id = p_target_id
  for update;
  if not found then
    select * into v_tombstone
    from private.account_storage_cleanup_tombstones tombstone
    where tombstone.user_id = p_target_id
    for update;
    if found and v_tombstone.state = 'storage_cleared' then
      update private.account_storage_cleanup_tombstones
      set state = 'post_purge_cleanup',
          auth_purged_at = coalesce(auth_purged_at, statement_timestamp()),
          empty_confirmed_at = null,
          lease_owner = null, lease_expires_at = null,
          next_attempt_at = statement_timestamp() + interval '15 minutes',
          updated_at = statement_timestamp(), last_error_code = null
      where id = v_tombstone.id;
      return jsonb_build_object(
        'deleted', false, 'userId', p_target_id, 'alreadyAbsent', true,
        'postPurgeCleanupPending', true
      );
    end if;
    return jsonb_build_object(
      'deleted', false, 'userId', p_target_id, 'alreadyAbsent', true,
      'postPurgeCleanupPending', v_tombstone.state in (
        'post_purge_cleanup', 'post_purge_empty_once'
      )
    );
  end if;
  perform 1
  from public.account_controls control
  where control.user_id = p_target_id and control.deletion_pending
  for update;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_PURGE_NOT_STARTED';
  end if;
  if private.has_pending_auth_admin_operation(p_target_id, v_email) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS';
  end if;
  select * into v_tombstone
  from private.account_storage_cleanup_tombstones tombstone
  where tombstone.user_id = p_target_id
  for update;
  if not found or v_tombstone.state <> 'storage_cleared' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_STORAGE_CLEANUP_PENDING';
  end if;
  if exists (
    select 1 from private.avatar_upload_operations operation
    where operation.user_id = p_target_id
      and (
        operation.state not in ('committed', 'aborted')
        or operation.artifacts_cleared_at is null
      )
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_PURGE_NOT_READY';
  end if;

  select coalesce(
    array_agg(operation.id order by operation.id), '{}'::uuid[]
  )
  into v_operation_ids
  from private.auth_admin_outbox operation
  where operation.actor_user_id = p_target_id
    or operation.target_id = p_target_id
    or (
      operation.operation_type in ('suspend', 'restore')
      and operation.payload ->> 'targetId' = p_target_id::text
    )
    or (
      operation.operation_type = 'invite'
      and lower(btrim(operation.payload ->> 'email')) = v_email
    );

  perform set_config('safetyhub.purge_actor_id', p_target_id::text, true);
  perform set_config('safetyhub.storage_purge_user_id', p_target_id::text, true);
  perform set_config(
    'safetyhub.purge_operation_ids',
    array_to_string(v_operation_ids, ','),
    true
  );
  update public.test_revisions
  set published_by = null
  where published_by = p_target_id;
  update public.certificates
  set issued_by = case when issued_by = p_target_id then null else issued_by end,
      revoked_by = case when revoked_by = p_target_id then null else revoked_by end
  where issued_by = p_target_id or revoked_by = p_target_id;

  delete from public.admin_audit_log audit
  where audit.actor_user_id = p_target_id
    or audit.target_user_id = p_target_id
    or (
      audit.target_type = 'auth_admin_operation'
      and audit.target_id = any(
        array(select operation_id::text from unnest(v_operation_ids) operation_id)
      )
    );
  delete from private.auth_admin_outbox operation
  where operation.id = any(v_operation_ids);
  delete from private.avatar_upload_operations operation
  where operation.user_id = p_target_id;
  delete from private.profile_avatar_manifests manifest
  where manifest.user_id = p_target_id;
  delete from private.signup_legal_operations operation
  where operation.completed_user_id = p_target_id
    or operation.normalized_email = v_email;
  delete from auth.users where id = p_target_id;
  v_deleted := found;
  update private.account_storage_cleanup_tombstones
  set state = 'post_purge_cleanup', auth_purged_at = statement_timestamp(),
      empty_confirmed_at = null,
      next_attempt_at = statement_timestamp() + interval '15 minutes',
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where id = v_tombstone.id;
  return jsonb_build_object(
    'deleted', v_deleted, 'userId', p_target_id,
    'postPurgeCleanupPending', true
  );
end;
$$;

revoke execute on function public.begin_user_account_purge(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_user_account_purge(uuid) to service_role;
revoke execute on function public.purge_user_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.purge_user_account(uuid) to service_role;

create or replace function public.resolve_certificate_export(
  p_attestation_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('certificate.export');
  begin
    v_result := private.resolve_certificate_export_unmetered(
      p_attestation_ids
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- Re-state the complete browser boundary after changing implementations and,
-- for capabilities, the SQL return type. No helper or private implementation
-- is directly executable by PostgREST roles.
revoke execute on function public.update_profile(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.complete_profile_onboarding(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.accept_current_legal_documents(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.set_article_status(uuid,public.article_status)
  from public, anon, authenticated, service_role;
revoke execute on function public.save_test_content(
  uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.set_test_status(uuid,uuid,public.test_status)
  from public, anon, authenticated, service_role;
revoke execute on function public.start_test_attempt(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.complete_test_attempt(uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.verify_user_identity(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.revoke_user_identity(uuid,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.confirm_admin_identities(uuid[])
  from public, anon, authenticated, service_role;
revoke execute on function public.bulk_update_participants(uuid[],text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.issue_certificates(uuid[])
  from public, anon, authenticated, service_role;
revoke execute on function public.revoke_certificates(uuid[],text)
  from public, anon, authenticated, service_role;
revoke execute on function public.revoke_certificate(uuid,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.update_site_settings(text,text,text,boolean,bigint)
  from public, anon, authenticated, service_role;
revoke execute on function public.prepare_user_invite(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.request_account_suspension_confirmed(
  uuid,boolean,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.manage_user_role_confirmed(
  uuid,public.app_role,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.claim_auth_admin_operation_confirmed(
  uuid,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.resolve_certificate_export(uuid[])
  from public, anon, authenticated, service_role;

grant execute on function public.update_profile(text,text,text,text) to authenticated;
grant execute on function public.complete_profile_onboarding(text,text,text,text)
  to authenticated;
grant execute on function public.accept_current_legal_documents(text,text,text,text)
  to authenticated;
grant execute on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  to authenticated;
grant execute on function public.set_article_status(uuid,public.article_status)
  to authenticated;
grant execute on function public.save_test_content(
  uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb
) to authenticated;
grant execute on function public.set_test_status(uuid,uuid,public.test_status)
  to authenticated;
grant execute on function public.start_test_attempt(text) to authenticated;
grant execute on function public.complete_test_attempt(uuid,jsonb) to authenticated;
grant execute on function public.verify_user_identity(uuid,text,text,text,text)
  to authenticated;
grant execute on function public.revoke_user_identity(uuid,text) to authenticated;
grant execute on function public.confirm_admin_identities(uuid[]) to authenticated;
grant execute on function public.bulk_update_participants(uuid[],text,text)
  to authenticated;
grant execute on function public.issue_certificates(uuid[]) to authenticated;
grant execute on function public.revoke_certificates(uuid[],text) to authenticated;
grant execute on function public.revoke_certificate(uuid,text) to authenticated;
grant execute on function public.update_site_settings(text,text,text,boolean,bigint)
  to authenticated;
grant execute on function public.prepare_user_invite(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) to authenticated;
grant execute on function public.request_account_suspension_confirmed(
  uuid,boolean,text,uuid,text,text,text
) to authenticated;
grant execute on function public.manage_user_role_confirmed(
  uuid,public.app_role,text,uuid,text,text,text
) to authenticated;
grant execute on function public.claim_auth_admin_operation_confirmed(
  uuid,text,uuid,text,text,text
) to authenticated;
grant execute on function public.resolve_certificate_export(uuid[]) to authenticated;
