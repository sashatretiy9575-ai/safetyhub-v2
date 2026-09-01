-- Fail-closed production cutover controls for transactional product events and
-- Telegram delivery. Application-only route flags live in the Vercel runtime;
-- these database flags keep trigger/worker activation independently reversible.

create table private.runtime_feature_flags (
  feature_name text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint runtime_feature_name check (
    feature_name in ('notification_events', 'telegram_delivery')
  )
);

insert into private.runtime_feature_flags(feature_name, enabled)
values ('notification_events', false), ('telegram_delivery', false);

create table private.runtime_feature_flag_receipts (
  idempotency_key uuid primary key,
  feature_name text not null,
  requested_enabled boolean not null,
  reason text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint runtime_feature_receipt_name check (
    feature_name in ('notification_events', 'telegram_delivery')
  ),
  constraint runtime_feature_receipt_reason check (
    char_length(reason) between 8 and 500
    and reason !~ '[[:cntrl:]]'
  ),
  constraint runtime_feature_receipt_result check (
    jsonb_typeof(result) = 'object'
    and pg_column_size(result) <= 4096
  )
);

create function private.runtime_feature_enabled(p_feature_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select flag.enabled
    from private.runtime_feature_flags flag
    where flag.feature_name = p_feature_name
  ), false)
$$;

-- Preserve the original, already-reviewed service implementations behind
-- wrappers so the cutover gate cannot be bypassed by the dispatcher.
alter function public.emit_system_notification_alert(text,uuid,text)
  rename to emit_system_notification_alert_unmetered;
alter function public.emit_system_notification_alert_unmetered(text,uuid,text)
  set schema private;

create function public.emit_system_notification_alert(
  p_machine_code text,
  p_correlation_id uuid,
  p_admin_path text default '/admin'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not private.runtime_feature_enabled('notification_events') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_EVENTS_DISABLED';
  end if;
  return private.emit_system_notification_alert_unmetered(
    p_machine_code,
    p_correlation_id,
    p_admin_path
  );
end;
$$;

alter function public.claim_notification_deliveries(uuid,integer,integer)
  rename to claim_notification_deliveries_unmetered;
alter function public.claim_notification_deliveries_unmetered(uuid,integer,integer)
  set schema private;

create function public.claim_notification_deliveries(
  p_worker_id uuid,
  p_limit integer default 20,
  p_lease_seconds integer default 45
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not private.runtime_feature_enabled('telegram_delivery') then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  return private.claim_notification_deliveries_unmetered(
    p_worker_id,
    p_limit,
    p_lease_seconds
  );
end;
$$;

drop trigger account_controls_emit_approval_notification
  on public.account_controls;
create trigger account_controls_emit_approval_notification
after update of approval_state, approval_requested_at
on public.account_controls
for each row
when (private.runtime_feature_enabled('notification_events'))
execute function private.emit_approval_requested_notification();

drop trigger test_attempts_emit_completion_notification
  on public.test_attempts;
create trigger test_attempts_emit_completion_notification
after update of status on public.test_attempts
for each row
when (private.runtime_feature_enabled('notification_events'))
execute function private.emit_course_completed_notification();

drop trigger notification_deliveries_request_dispatch
  on private.notification_deliveries;
create trigger notification_deliveries_request_dispatch
after insert on private.notification_deliveries
for each row
when (private.runtime_feature_enabled('telegram_delivery'))
execute function private.request_notification_dispatch_after_insert();

-- Replace the existing named job with an independently gated sweep.
select cron.schedule(
  'safetyhub-notification-dispatch',
  '* * * * *',
  'select private.request_notification_dispatch(''scheduled'', null) where private.runtime_feature_enabled(''telegram_delivery'');'
);

create function public.set_runtime_feature_flag(
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
  if p_feature_name not in ('notification_events', 'telegram_delivery')
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
  if p_feature_name = 'notification_events'
    and not p_enabled
    and private.runtime_feature_enabled('telegram_delivery') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_DELIVERY_MUST_BE_DISABLED_FIRST';
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

alter table private.runtime_feature_flags enable row level security;
alter table private.runtime_feature_flag_receipts enable row level security;

revoke all on table private.runtime_feature_flags,
  private.runtime_feature_flag_receipts
from public, anon, authenticated, service_role;

revoke all on function private.runtime_feature_enabled(text),
  private.emit_system_notification_alert_unmetered(text,uuid,text),
  private.claim_notification_deliveries_unmetered(uuid,integer,integer)
from public, anon, authenticated, service_role;

revoke all on function public.emit_system_notification_alert(text,uuid,text),
  public.claim_notification_deliveries(uuid,integer,integer),
  public.set_runtime_feature_flag(text,boolean,text,uuid)
from public, anon, authenticated, service_role;

grant execute on function public.emit_system_notification_alert(text,uuid,text),
  public.claim_notification_deliveries(uuid,integer,integer),
  public.set_runtime_feature_flag(text,boolean,text,uuid)
to service_role;

comment on table private.runtime_feature_flags is
  'Fail-closed operational cutover state for notification event emission and Telegram delivery.';
comment on function public.set_runtime_feature_flag(text,boolean,text,uuid) is
  'Service-only, reasoned, idempotent release control. Enable events before Telegram; disable in reverse order.';

