-- Sign-in email that cannot be lost, and one database round-trip per OTP step.
--
-- 1. private.auth_email_outbox: every message Supabase Auth hands to the
--    send-email hook is recorded before the hook answers 200. The hook then
--    tries to deliver at once; anything the mailbox refuses is retried by a
--    drain that pg_cron calls through Vault, with backoff, and is reported as
--    a system alert after the last attempt. Only template inputs are stored
--    (kind, locale, code); the code is erased the moment the row is sent or
--    given up. A replayed webhook (same id inside the signature window) is a
--    duplicate, never a second email.
-- 2. begin_email_otp_request / begin_email_otp_verify: the network quota, the
--    per-address cooldown and the pending self-deletion sweep used to be
--    separate service-role calls before Auth was even asked; they are one call
--    now. The challenge receipt itself is still issued only after Auth has
--    accepted the CAPTCHA and sent the code, so nobody can start a cooldown
--    for somebody else's address without passing the CAPTCHA.

-- 1. Outbox ---------------------------------------------------------------

create table private.auth_email_outbox (
  id uuid primary key default gen_random_uuid(),
  webhook_id text not null unique,
  recipient text not null,
  locale text not null,
  kind text not null,
  token text,
  status text not null default 'queued',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default statement_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default statement_timestamp(),
  sent_at timestamptz,
  constraint auth_email_outbox_webhook_id_shape
    check (char_length(webhook_id) between 1 and 200),
  constraint auth_email_outbox_recipient_shape
    check (recipient ~ '^[^[:space:]<>@,;"]+@[^[:space:]<>@,;"]+$' and char_length(recipient) <= 320),
  constraint auth_email_outbox_locale_shape check (locale in ('ru', 'kk', 'en')),
  constraint auth_email_outbox_kind_shape
    check (kind in ('signup', 'magiclink', 'recovery', 'invite')),
  constraint auth_email_outbox_token_shape
    check (token is null or token ~ '^[0-9]{6,10}$'),
  constraint auth_email_outbox_status_shape
    check (status in ('queued', 'sending', 'sent', 'failed')),
  constraint auth_email_outbox_attempts_shape check (attempts between 0 and 6),
  constraint auth_email_outbox_error_shape
    check (last_error is null or last_error ~ '^[A-Z0-9_]{1,64}$')
);

create index auth_email_outbox_drain_idx
  on private.auth_email_outbox (next_attempt_at, id)
  where status in ('queued', 'sending');

create index auth_email_outbox_retention_idx
  on private.auth_email_outbox (created_at)
  where status in ('sent', 'failed');

alter table private.auth_email_outbox enable row level security;
revoke all on table private.auth_email_outbox
  from public, anon, authenticated, service_role;

comment on table private.auth_email_outbox is
  'Durable queue for Supabase Auth emails. Template inputs only; the one-time code is erased once the message is sent or abandoned.';

create function public.enqueue_auth_email(
  p_webhook_id text,
  p_recipient text,
  p_locale text,
  p_kind text,
  p_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_inserted boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  insert into private.auth_email_outbox (webhook_id, recipient, locale, kind, token)
  values (p_webhook_id, lower(btrim(p_recipient)), p_locale, p_kind, nullif(p_token, ''))
  on conflict (webhook_id) do nothing
  returning id into v_id;
  v_inserted := v_id is not null;
  if not v_inserted then
    select outbox.id into v_id
    from private.auth_email_outbox outbox
    where outbox.webhook_id = p_webhook_id;
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', not v_inserted);
end;
$$;

create function public.claim_auth_email_outbox(
  p_worker_id uuid,
  p_limit integer default 10,
  p_lease_seconds integer default 60,
  p_only_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lease_token uuid := gen_random_uuid();
  v_rows jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_worker_id is null
    or p_limit is null or p_limit not between 1 and 50
    or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception using errcode = '22023', message = 'AUTH_EMAIL_CLAIM_INVALID';
  end if;

  with due as (
    select outbox.id
    from private.auth_email_outbox outbox
    where (p_only_id is null or outbox.id = p_only_id)
      and (
        (outbox.status = 'queued' and outbox.next_attempt_at <= statement_timestamp())
        or (outbox.status = 'sending' and outbox.lease_until <= statement_timestamp())
      )
    order by outbox.next_attempt_at, outbox.id
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update private.auth_email_outbox outbox
    set status = 'sending',
        attempts = outbox.attempts + 1,
        lease_token = v_lease_token,
        lease_until = statement_timestamp() + make_interval(secs => p_lease_seconds)
    from due
    where outbox.id = due.id
    returning outbox.id, outbox.recipient, outbox.locale, outbox.kind, outbox.token, outbox.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', claimed.id,
    'recipient', claimed.recipient,
    'locale', claimed.locale,
    'kind', claimed.kind,
    'token', claimed.token,
    'attempts', claimed.attempts,
    'leaseToken', v_lease_token
  ) order by claimed.id), '[]'::jsonb)
  into v_rows
  from claimed;
  return v_rows;
end;
$$;

create function public.complete_auth_email(p_id uuid, p_lease_token uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_done integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update private.auth_email_outbox outbox
  set status = 'sent',
      token = null,
      sent_at = statement_timestamp(),
      lease_token = null,
      lease_until = null,
      last_error = null
  where outbox.id = p_id
    and outbox.status = 'sending'
    and outbox.lease_token = p_lease_token;
  get diagnostics v_done = row_count;
  return v_done > 0;
end;
$$;

create function public.fail_auth_email(
  p_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry_after_seconds integer default 120
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.auth_email_outbox%rowtype;
  v_retry integer := least(greatest(coalesce(p_retry_after_seconds, 120), 30), 3600);
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  select * into v_row
  from private.auth_email_outbox outbox
  where outbox.id = p_id and outbox.lease_token = p_lease_token and outbox.status = 'sending'
  for update;
  if not found then
    return jsonb_build_object('updated', false);
  end if;
  if v_row.attempts >= 5 then
    update private.auth_email_outbox outbox
    set status = 'failed',
        token = null,
        lease_token = null,
        lease_until = null,
        last_error = coalesce(nullif(p_error, ''), 'SMTP_FAILED')
    where outbox.id = p_id;
    -- The operator inbox learns about the dead message; the recipient never
    -- got a code and will have to request a new one.
    begin
      perform public.emit_system_notification_alert('AUTH_EMAIL_DEAD', gen_random_uuid(), '/admin');
    exception when others then
      null;
    end;
    return jsonb_build_object('updated', true, 'status', 'failed');
  end if;
  update private.auth_email_outbox outbox
  set status = 'queued',
      lease_token = null,
      lease_until = null,
      last_error = coalesce(nullif(p_error, ''), 'SMTP_FAILED'),
      next_attempt_at = statement_timestamp() + make_interval(secs => v_retry)
  where outbox.id = p_id;
  return jsonb_build_object('updated', true, 'status', 'queued', 'retryAfter', v_retry);
end;
$$;

-- The mailbox said "slow down" (421/450/452 or a rate-limit reply): the
-- message goes back to the queue for later without spending one of its
-- attempts, because nothing was wrong with the message itself.
create function public.defer_auth_email(
  p_id uuid,
  p_lease_token uuid,
  p_retry_after_seconds integer default 600
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_done integer;
  v_retry integer := least(greatest(coalesce(p_retry_after_seconds, 600), 60), 3600);
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  update private.auth_email_outbox outbox
  set status = 'queued',
      attempts = greatest(0, outbox.attempts - 1),
      lease_token = null,
      lease_until = null,
      last_error = 'MAILBOX_THROTTLED',
      next_attempt_at = statement_timestamp() + make_interval(secs => v_retry)
  where outbox.id = p_id
    and outbox.status = 'sending'
    and outbox.lease_token = p_lease_token;
  get diagnostics v_done = row_count;
  return v_done > 0;
end;
$$;

create function public.prune_auth_email_outbox(p_limit integer default 500)
returns integer
language plpgsql
volatile
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
  with old as (
    select outbox.id
    from private.auth_email_outbox outbox
    where outbox.status in ('sent', 'failed')
      and outbox.created_at < statement_timestamp() - interval '7 days'
    order by outbox.created_at
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  )
  delete from private.auth_email_outbox outbox
  using old
  where outbox.id = old.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create function public.auth_email_outbox_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce((select auth.role()), '') <> 'service_role' then null
    else jsonb_build_object(
      'queued', (select count(*) from private.auth_email_outbox where status = 'queued'),
      'sending', (select count(*) from private.auth_email_outbox where status = 'sending'),
      'failedLastDay', (
        select count(*) from private.auth_email_outbox
        where status = 'failed' and created_at > statement_timestamp() - interval '1 day'
      ),
      'sentLastHour', (
        select count(*) from private.auth_email_outbox
        where status = 'sent' and sent_at > statement_timestamp() - interval '1 hour'
      )
    )
  end;
$$;

revoke execute on function public.enqueue_auth_email(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_auth_email(text, text, text, text, text) to service_role;
revoke execute on function public.claim_auth_email_outbox(uuid, integer, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_auth_email_outbox(uuid, integer, integer, uuid) to service_role;
revoke execute on function public.complete_auth_email(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_auth_email(uuid, uuid) to service_role;
revoke execute on function public.fail_auth_email(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.fail_auth_email(uuid, uuid, text, integer) to service_role;
revoke execute on function public.defer_auth_email(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.defer_auth_email(uuid, uuid, integer) to service_role;
revoke execute on function public.prune_auth_email_outbox(integer) from public, anon, authenticated;
grant execute on function public.prune_auth_email_outbox(integer) to service_role;
revoke execute on function public.auth_email_outbox_summary() from public, anon, authenticated;
grant execute on function public.auth_email_outbox_summary() to service_role;

-- The drain lives on Vercel; pg_cron reaches it through Vault, like the
-- notification dispatcher. Unconfigured Vault keeps the job a silent no-op.
create function private.request_auth_email_drain()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  begin
    execute $query$
      select decrypted_secret from vault.decrypted_secrets
      where name = 'auth_email_drain_url' limit 1
    $query$ into v_url;
    execute $query$
      select decrypted_secret from vault.decrypted_secrets
      where name = 'auth_email_drain_secret' limit 1
    $query$ into v_secret;
  exception when others then
    return null;
  end;
  if nullif(btrim(v_url), '') is null
    or v_url !~ '^https://[^[:space:]]+$'
    or nullif(v_secret, '') is null
    or char_length(v_secret) < 32 then
    return null;
  end if;
  begin
    select net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object('reason', 'scheduled', 'requestedAt', statement_timestamp()),
      timeout_milliseconds := 5000
    ) into v_request_id;
  exception when others then
    return null;
  end;
  return v_request_id;
end;
$$;

revoke all on function private.request_auth_email_drain() from public;

create function public.configure_auth_email_drain_vault(
  p_drain_url text,
  p_drain_secret text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url_ids uuid[];
  v_secret_ids uuid[];
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_drain_url is null
    or char_length(p_drain_url) > 512
    or p_drain_url !~ '^https://[a-z0-9.-]+/api/auth/send-email/drain$'
    or p_drain_secret is null
    or char_length(p_drain_secret) not between 32 and 512
    or p_drain_secret ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation',
      message = 'AUTH_EMAIL_DRAIN_VAULT_REQUEST_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('auth-email-drain-vault-config', 0));
  execute $query$
    select coalesce(array_agg(secret.id order by secret.id), '{}'::uuid[])
    from vault.secrets secret where secret.name = 'auth_email_drain_url'
  $query$ into v_url_ids;
  execute $query$
    select coalesce(array_agg(secret.id order by secret.id), '{}'::uuid[])
    from vault.secrets secret where secret.name = 'auth_email_drain_secret'
  $query$ into v_secret_ids;
  if cardinality(v_url_ids) > 1 or cardinality(v_secret_ids) > 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AUTH_EMAIL_DRAIN_VAULT_AMBIGUOUS';
  end if;

  if cardinality(v_url_ids) = 0 then
    execute 'select vault.create_secret($1, $2, $3)'
      using p_drain_url, 'auth_email_drain_url', 'Sign-in email drain URL called by pg_cron';
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_url_ids[1], p_drain_url, 'auth_email_drain_url',
        'Sign-in email drain URL called by pg_cron';
  end if;
  if cardinality(v_secret_ids) = 0 then
    execute 'select vault.create_secret($1, $2, $3)'
      using p_drain_secret, 'auth_email_drain_secret', 'Bearer secret for the sign-in email drain';
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_secret_ids[1], p_drain_secret, 'auth_email_drain_secret',
        'Bearer secret for the sign-in email drain';
  end if;
  return jsonb_build_object('configured', true, 'configuredAt', statement_timestamp());
end;
$$;

revoke execute on function public.configure_auth_email_drain_vault(text, text)
  from public, anon, authenticated;
grant execute on function public.configure_auth_email_drain_vault(text, text) to service_role;

select cron.schedule(
  'safetyhub-auth-email-drain',
  '*/2 * * * *',
  $job$
    select private.request_auth_email_drain()
    where exists (
      select 1
      from private.auth_email_outbox outbox
      where (outbox.status = 'queued' and outbox.next_attempt_at <= statement_timestamp())
        or (outbox.status = 'sending' and outbox.lease_until <= statement_timestamp())
    )
  $job$
);

select cron.schedule(
  'safetyhub-auth-email-prune',
  '45 4 * * *',
  $job$select public.prune_auth_email_outbox(500);$job$
);

-- 2. One round-trip per OTP step ----------------------------------------------

create function public.begin_email_otp_request(
  p_ip_hash text,
  p_email text,
  p_email_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_quota jsonb;
  v_recent timestamptz;
  v_purge jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_email is null
    or char_length(p_email) not between 3 and 320
    or p_email_hash is null
    or p_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'OTP_REQUEST_INVALID';
  end if;

  -- Network budget first: a caller over quota never reaches Auth.
  v_quota := public.consume_coarse_ip_quota('auth.otp.start', p_ip_hash);
  if coalesce(v_quota ->> 'allowed', 'false') <> 'true' then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limited',
      'retryAfter', greatest(1, coalesce((v_quota ->> 'retryAfter')::integer, 1))
    );
  end if;

  -- One code per address per minute is Supabase's own rule (max_frequency).
  -- A receipt exists only after Auth has sent a code, so answering here saves
  -- the Auth round-trip and tells the person exactly how long to wait without
  -- letting anyone start a cooldown for an address they do not control.
  select max(challenge.issued_at) into v_recent
  from private.email_otp_challenges challenge
  where challenge.email_hash = p_email_hash
    and challenge.issued_at > statement_timestamp() - interval '60 seconds';
  if v_recent is not null then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'address_cooldown',
      'retryAfter', greatest(1, 60 - floor(extract(epoch from statement_timestamp() - v_recent)))::integer
    );
  end if;

  -- A self-deletion the old staged path never finished still owns this email.
  -- Finish it so the sign-in creates a brand-new account; a failure here never
  -- blocks the sign-in.
  begin
    v_purge := public.purge_pending_self_deletion(p_email);
  exception when others then
    v_purge := null;
  end;
  return jsonb_build_object(
    'allowed', true,
    'purgedUserId', case
      when v_purge ->> 'purged' = 'true' and v_purge ->> 'status' = 'completed'
      then v_purge ->> 'id'
    end
  );
end;
$$;

create function public.begin_email_otp_verify(
  p_ip_hash text,
  p_challenge_hash text,
  p_email_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_quota jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  v_quota := public.consume_coarse_ip_quota('auth.otp.verify', p_ip_hash);
  if coalesce(v_quota ->> 'allowed', 'false') <> 'true' then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limited',
      'retryAfter', greatest(1, coalesce((v_quota ->> 'retryAfter')::integer, 1))
    );
  end if;
  return public.consume_email_otp_challenge_attempt(p_challenge_hash, p_email_hash);
end;
$$;

revoke execute on function public.begin_email_otp_request(text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_email_otp_request(text, text, text) to service_role;
revoke execute on function public.begin_email_otp_verify(text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_email_otp_verify(text, text, text) to service_role;
