-- A service-role-only, reasoned and idempotent boundary for configuring the two
-- Vault values consumed by private.request_notification_dispatch. Secret bytes
-- never enter audit rows, receipts, function results or migration text.

create table private.notification_dispatch_vault_receipts (
  idempotency_key uuid primary key,
  request_hash text not null,
  reason text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint notification_dispatch_vault_receipt_hash check (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint notification_dispatch_vault_receipt_reason check (
    char_length(reason) between 8 and 500
    and reason !~ '[[:cntrl:]]'
  ),
  constraint notification_dispatch_vault_receipt_result check (
    jsonb_typeof(result) = 'object'
    and pg_column_size(result) <= 4096
  )
);

create function public.configure_notification_dispatch_vault(
  p_dispatch_url text,
  p_dispatch_secret text,
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
  v_request_hash text;
  v_existing private.notification_dispatch_vault_receipts%rowtype;
  v_url_ids uuid[];
  v_secret_ids uuid[];
  v_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_dispatch_url is null
    or char_length(p_dispatch_url) > 512
    or p_dispatch_url !~ '^https://[a-z0-9]{20}[.]supabase[.]co/functions/v1/telegram-dispatcher$'
    or p_dispatch_secret is null
    or char_length(p_dispatch_secret) not between 32 and 512
    or p_dispatch_secret ~ '[[:cntrl:]]'
    or p_reason is null
    or char_length(p_reason) not between 8 and 500
    or p_reason ~ '[[:cntrl:]]'
    or p_idempotency_key is null then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_DISPATCH_VAULT_REQUEST_INVALID';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'dispatchUrl', p_dispatch_url,
      'dispatchSecret', p_dispatch_secret,
      'reason', p_reason
    )::text,
    'UTF8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('notification-dispatch-vault-config', 0));
  select * into v_existing
  from private.notification_dispatch_vault_receipts receipt
  where receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> v_request_hash or v_existing.reason <> p_reason then
      raise exception using errcode = 'unique_violation',
        message = 'NOTIFICATION_DISPATCH_VAULT_IDEMPOTENCY_CONFLICT';
    end if;
    return v_existing.result;
  end if;

  execute $query$
    select coalesce(array_agg(secret.id order by secret.id), '{}'::uuid[])
    from vault.secrets secret
    where secret.name = 'notification_dispatch_url'
  $query$ into v_url_ids;
  execute $query$
    select coalesce(array_agg(secret.id order by secret.id), '{}'::uuid[])
    from vault.secrets secret
    where secret.name = 'notification_dispatch_secret'
  $query$ into v_secret_ids;

  if cardinality(v_url_ids) > 1 or cardinality(v_secret_ids) > 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_DISPATCH_VAULT_NAME_AMBIGUOUS';
  end if;

  if cardinality(v_url_ids) = 0 then
    execute 'select vault.create_secret($1, $2, $3)'
      using p_dispatch_url, 'notification_dispatch_url',
        'SafetyHub Telegram dispatcher Edge Function URL';
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_url_ids[1], p_dispatch_url, 'notification_dispatch_url',
        'SafetyHub Telegram dispatcher Edge Function URL';
  end if;

  if cardinality(v_secret_ids) = 0 then
    execute 'select vault.create_secret($1, $2, $3)'
      using p_dispatch_secret, 'notification_dispatch_secret',
        'SafetyHub Telegram dispatcher bearer';
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_secret_ids[1], p_dispatch_secret, 'notification_dispatch_secret',
        'SafetyHub Telegram dispatcher bearer';
  end if;

  v_result := jsonb_build_object(
    'configured', true,
    'vaultNames', jsonb_build_array(
      'notification_dispatch_url',
      'notification_dispatch_secret'
    )
  );

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
    'notification_dispatch.vault_configured',
    'notification_dispatch',
    'telegram-dispatcher',
    null,
    jsonb_build_object(
      'configured', true,
      'vaultNames', v_result -> 'vaultNames'
    ),
    p_reason,
    p_idempotency_key
  );

  insert into private.notification_dispatch_vault_receipts (
    idempotency_key,
    request_hash,
    reason,
    result
  ) values (
    p_idempotency_key,
    v_request_hash,
    p_reason,
    v_result
  );

  return v_result;
end;
$$;

alter table private.notification_dispatch_vault_receipts enable row level security;

revoke all on table private.notification_dispatch_vault_receipts
from public, anon, authenticated, service_role;

revoke all on function public.configure_notification_dispatch_vault(text,text,text,uuid)
from public, anon, authenticated, service_role;

grant execute on function public.configure_notification_dispatch_vault(text,text,text,uuid)
to service_role;

comment on function public.configure_notification_dispatch_vault(text,text,text,uuid) is
  'Service-only idempotent Vault upsert for Telegram dispatcher URL/bearer. Results and audit rows never contain secret bytes.';
