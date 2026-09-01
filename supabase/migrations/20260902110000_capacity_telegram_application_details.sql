-- Low-cardinality prototype capacity telemetry plus an explicit delivery gate
-- for the owner-approved, full application details sent to a private Telegram
-- group. The gate defaults to false; this migration never enables delivery.

alter table private.runtime_feature_flags
  drop constraint runtime_feature_name;
alter table private.runtime_feature_flags
  add constraint runtime_feature_name check (
    feature_name in (
      'notification_events',
      'telegram_delivery',
      'telegram_application_details'
    )
  );

alter table private.runtime_feature_flag_receipts
  drop constraint runtime_feature_receipt_name;
alter table private.runtime_feature_flag_receipts
  add constraint runtime_feature_receipt_name check (
    feature_name in (
      'notification_events',
      'telegram_delivery',
      'telegram_application_details'
    )
  );

insert into private.runtime_feature_flags(feature_name, enabled)
values ('telegram_application_details', false)
on conflict (feature_name) do nothing;

-- `telegram_application_details` is deliberately dependent on the two
-- existing gates. It prevents profile contact data from entering an event row
-- or an external delivery until the dispatcher is proven operational.
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
      'notification_events', 'telegram_delivery', 'telegram_application_details'
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

-- Supersede the notification trigger without rewriting the applied migration.
-- The full profile application is only constructed after the separate gate is
-- enabled. The telephone is a contact field, never an Auth phone identity.
create or replace function private.emit_approval_requested_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_include_application_details boolean;
begin
  if not private.runtime_feature_enabled('notification_events') then
    return new;
  end if;
  if new.approval_state <> 'pending'
    or new.approval_requested_at is null
    or (
      old.approval_state = 'pending'
      and old.approval_requested_at is not distinct from new.approval_requested_at
    ) then
    return new;
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = new.user_id;
  if not found then
    return new;
  end if;

  v_include_application_details := private.runtime_feature_enabled(
    'telegram_application_details'
  );
  if v_include_application_details
    and (
      char_length(v_profile.name) = 0
      or char_length(v_profile.surname) = 0
      or char_length(v_profile.job) = 0
      or char_length(v_profile.organization) = 0
      or coalesce(v_profile.phone_country_iso2, '') !~ '^[A-Z]{2}$'
      or coalesce(v_profile.phone_e164, '') !~ '^\+[1-9][0-9]{1,14}$'
    ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TELEGRAM_APPLICATION_DETAILS_INCOMPLETE';
  end if;

  insert into private.notification_events (
    event_type,
    aggregate_type,
    aggregate_id,
    dedupe_key,
    payload,
    occurred_at
  ) values (
    'account.approval_requested',
    'account',
    new.user_id,
    'approval:' || new.user_id::text || ':'
      || extract(epoch from new.approval_requested_at)::numeric(20,6)::text,
    case
      when v_include_application_details then jsonb_build_object(
        'name', v_profile.name,
        'surname', v_profile.surname,
        'job', v_profile.job,
        'organization', v_profile.organization,
        'phoneCountryIso2', v_profile.phone_country_iso2,
        'phoneE164', v_profile.phone_e164
      )
      else jsonb_build_object(
        'name', v_profile.name,
        'surname', v_profile.surname,
        'locale', v_profile.preferred_locale,
        'requestedAt', new.approval_requested_at,
        'adminPath', '/admin/approvals'
      )
    end,
    new.approval_requested_at
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

-- The daily snapshot has one row per Asia/Oral calendar day and deliberately
-- contains aggregates only. It is monitoring, not an admission cap: the owner
-- chose alerts at 70/85/95% of the initial 100 active-learner prototype budget.
create table private.capacity_monitor_configuration (
  singleton boolean primary key default true check (singleton),
  monthly_active_learner_limit integer not null default 100
    check (monthly_active_learner_limit between 1 and 1000000),
  warning_percent smallint not null default 70 check (warning_percent = 70),
  action_percent smallint not null default 85 check (action_percent = 85),
  critical_percent smallint not null default 95 check (critical_percent = 95),
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into private.capacity_monitor_configuration(singleton)
values (true)
on conflict (singleton) do nothing;

create table private.capacity_monitor_snapshots (
  captured_day date primary key,
  month_start date not null,
  captured_at timestamptz not null default statement_timestamp(),
  metrics jsonb not null,
  constraint capacity_monitor_snapshot_month check (
    month_start = date_trunc('month', captured_day)::date
  ),
  constraint capacity_monitor_snapshot_metrics check (
    jsonb_typeof(metrics) = 'object'
    and pg_column_size(metrics) <= 4096
  )
);

create table private.capacity_monitor_alert_state (
  month_start date not null,
  metric_key text not null default 'monthly_active_learners',
  highest_threshold_percent smallint not null,
  observed_value bigint not null,
  limit_value integer not null,
  first_reached_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (month_start, metric_key),
  constraint capacity_monitor_alert_metric check (metric_key = 'monthly_active_learners'),
  constraint capacity_monitor_alert_threshold check (
    highest_threshold_percent in (70, 85, 95)
  ),
  constraint capacity_monitor_alert_values check (
    observed_value >= 0 and limit_value > 0
  )
);

create table private.capacity_monitor_budget_receipts (
  idempotency_key uuid primary key,
  requested_limit integer not null check (requested_limit between 1 and 1000000),
  reason text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint capacity_monitor_budget_reason check (
    char_length(reason) between 8 and 500 and reason !~ '[[:cntrl:]]'
  ),
  constraint capacity_monitor_budget_result check (
    jsonb_typeof(result) = 'object' and pg_column_size(result) <= 4096
  )
);

-- pg_cron executes without an HTTP JWT. The public wrapper retains its
-- service-role boundary; this private implementation is callable only from
-- trusted SECURITY DEFINER jobs and keeps the same input validation and event
-- shape as the original implementation.
create or replace function private.emit_system_notification_alert_unmetered(
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
declare
  v_event_id uuid;
begin
  if p_machine_code is null
    or char_length(p_machine_code) not between 3 and 80
    or p_machine_code !~ '^[A-Z][A-Z0-9_]+$'
    or p_correlation_id is null
    or p_admin_path is null
    or char_length(p_admin_path) not between 1 and 240
    or p_admin_path !~ '^/admin(?:/|$)' then
    raise exception using errcode = 'check_violation',
      message = 'SYSTEM_ALERT_INVALID';
  end if;

  insert into private.notification_events (
    event_type,
    aggregate_type,
    dedupe_key,
    correlation_id,
    payload
  ) values (
    'system.alert',
    'system',
    'system:' || p_machine_code || ':' || p_correlation_id::text,
    p_correlation_id,
    jsonb_build_object(
      'machineCode', p_machine_code,
      'correlationId', p_correlation_id,
      'adminPath', p_admin_path
    )
  )
  on conflict (dedupe_key) do update
  set dedupe_key = excluded.dedupe_key
  returning id into v_event_id;
  return v_event_id;
end;
$$;

create function private.collect_capacity_monitor_snapshot_unmetered(
  p_force boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := (statement_timestamp() at time zone 'Asia/Oral')::date;
  v_month_start date := date_trunc(
    'month', statement_timestamp() at time zone 'Asia/Oral'
  )::date;
  v_month_started_at timestamptz;
  v_configuration private.capacity_monitor_configuration%rowtype;
  v_existing private.capacity_monitor_snapshots%rowtype;
  v_accounts bigint;
  v_approved_accounts bigint;
  v_monthly_active_learners bigint;
  v_attempt_starts bigint;
  v_database_bytes bigint;
  v_storage_bytes bigint;
  v_metrics jsonb;
  v_threshold smallint;
  v_alerted boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub.capacity_monitor.daily', 0));
  select * into v_existing
  from private.capacity_monitor_snapshots snapshot
  where snapshot.captured_day = v_day
  for update;
  if found and not coalesce(p_force, false) then
    return jsonb_build_object(
      'capturedDay', v_existing.captured_day,
      'monthStart', v_existing.month_start,
      'metrics', v_existing.metrics,
      'alreadyCaptured', true
    );
  end if;

  select * into v_configuration
  from private.capacity_monitor_configuration configuration
  where configuration.singleton
  for share;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CAPACITY_MONITOR_CONFIGURATION_MISSING';
  end if;

  v_month_started_at := v_month_start::timestamp at time zone 'Asia/Oral';
  select count(*) into v_accounts from auth.users;
  select count(*) into v_approved_accounts
  from public.account_controls control
  where control.approval_state = 'approved'
    and control.status = 'active'
    and not control.deletion_pending;
  select count(distinct attempt.user_id) into v_monthly_active_learners
  from public.test_attempts attempt
  where attempt.started_at >= v_month_started_at;
  select count(*) into v_attempt_starts
  from public.test_attempts attempt
  where attempt.started_at >= v_month_started_at;
  select pg_database_size(current_database()) into v_database_bytes;
  select coalesce(sum(
    case
      when stored_object.metadata ? 'size'
        and stored_object.metadata ->> 'size' ~ '^[0-9]+$'
      then (stored_object.metadata ->> 'size')::bigint
      else 0
    end
  ), 0) into v_storage_bytes
  from storage.objects stored_object;

  v_metrics := jsonb_build_object(
    'accounts', v_accounts,
    'approvedAccounts', v_approved_accounts,
    'monthlyActiveLearners', v_monthly_active_learners,
    'attemptStartsMonth', v_attempt_starts,
    'databaseBytes', v_database_bytes,
    'storageBytes', v_storage_bytes,
    'monthlyActiveLearnerLimit', v_configuration.monthly_active_learner_limit,
    'timezone', 'Asia/Oral'
  );
  insert into private.capacity_monitor_snapshots (
    captured_day, month_start, captured_at, metrics
  ) values (
    v_day, v_month_start, statement_timestamp(), v_metrics
  )
  on conflict (captured_day) do update
  set month_start = excluded.month_start,
      captured_at = excluded.captured_at,
      metrics = excluded.metrics;

  v_threshold := case
    when v_monthly_active_learners * 100 >= v_configuration.monthly_active_learner_limit * v_configuration.critical_percent
      then v_configuration.critical_percent
    when v_monthly_active_learners * 100 >= v_configuration.monthly_active_learner_limit * v_configuration.action_percent
      then v_configuration.action_percent
    when v_monthly_active_learners * 100 >= v_configuration.monthly_active_learner_limit * v_configuration.warning_percent
      then v_configuration.warning_percent
    else null
  end;

  if v_threshold is not null then
    insert into private.capacity_monitor_alert_state (
      month_start,
      metric_key,
      highest_threshold_percent,
      observed_value,
      limit_value
    ) values (
      v_month_start,
      'monthly_active_learners',
      v_threshold,
      v_monthly_active_learners,
      v_configuration.monthly_active_learner_limit
    )
    on conflict (month_start, metric_key) do update
    set highest_threshold_percent = excluded.highest_threshold_percent,
        observed_value = excluded.observed_value,
        limit_value = excluded.limit_value,
        updated_at = statement_timestamp()
    where private.capacity_monitor_alert_state.highest_threshold_percent
      < excluded.highest_threshold_percent
    returning true into v_alerted;

    if coalesce(v_alerted, false)
      and private.runtime_feature_enabled('notification_events') then
      perform private.emit_system_notification_alert_unmetered(
        'CAPACITY_MAU_' || v_threshold::text,
        gen_random_uuid(),
        '/admin/notifications'
      );
    end if;
  end if;

  return jsonb_build_object(
    'capturedDay', v_day,
    'monthStart', v_month_start,
    'metrics', v_metrics,
    'thresholdPercent', v_threshold,
    'alerted', coalesce(v_alerted, false),
    'alreadyCaptured', false
  );
end;
$$;

create function public.collect_capacity_monitor_snapshot(
  p_force boolean default false
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
  return private.collect_capacity_monitor_snapshot_unmetered(coalesce(p_force, false));
end;
$$;

create function public.set_capacity_monitor_monthly_active_learner_budget(
  p_monthly_active_learner_limit integer,
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
  v_existing private.capacity_monitor_budget_receipts%rowtype;
  v_before private.capacity_monitor_configuration%rowtype;
  v_after private.capacity_monitor_configuration%rowtype;
  v_result jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_monthly_active_learner_limit is null
    or p_monthly_active_learner_limit not between 1 and 1000000
    or p_reason is null
    or char_length(p_reason) not between 8 and 500
    or p_reason ~ '[[:cntrl:]]'
    or p_idempotency_key is null then
    raise exception using errcode = 'check_violation',
      message = 'CAPACITY_MONITOR_BUDGET_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_existing
  from private.capacity_monitor_budget_receipts receipt
  where receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.requested_limit <> p_monthly_active_learner_limit
      or v_existing.reason <> p_reason then
      raise exception using errcode = 'unique_violation',
        message = 'CAPACITY_MONITOR_BUDGET_IDEMPOTENCY_CONFLICT';
    end if;
    return v_existing.result;
  end if;

  select * into v_before
  from private.capacity_monitor_configuration configuration
  where configuration.singleton
  for update;
  update private.capacity_monitor_configuration
  set monthly_active_learner_limit = p_monthly_active_learner_limit,
      updated_at = statement_timestamp(),
      updated_by = (select auth.uid())
  where singleton
  returning * into v_after;

  v_result := jsonb_build_object(
    'monthlyActiveLearnerLimit', v_after.monthly_active_learner_limit,
    'changed', v_before.monthly_active_learner_limit
      is distinct from v_after.monthly_active_learner_limit,
    'updatedAt', v_after.updated_at
  );
  insert into private.capacity_monitor_budget_receipts (
    idempotency_key, requested_limit, reason, result
  ) values (
    p_idempotency_key, p_monthly_active_learner_limit, p_reason, v_result
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
    'capacity_monitor.budget_updated',
    'capacity_monitor',
    'monthly_active_learners',
    jsonb_build_object('monthlyActiveLearnerLimit', v_before.monthly_active_learner_limit),
    jsonb_build_object('monthlyActiveLearnerLimit', v_after.monthly_active_learner_limit),
    p_reason,
    p_idempotency_key
  );
  return v_result;
end;
$$;

-- The hourly schedule is intentionally cheap: the function writes at most one
-- daily row in Asia/Oral and returns its existing receipt on other invocations.
select cron.schedule(
  'safetyhub-capacity-monitor',
  '17 * * * *',
  'select private.collect_capacity_monitor_snapshot_unmetered(false);'
);

alter table private.capacity_monitor_configuration enable row level security;
alter table private.capacity_monitor_snapshots enable row level security;
alter table private.capacity_monitor_alert_state enable row level security;
alter table private.capacity_monitor_budget_receipts enable row level security;

revoke all on table private.runtime_feature_flags,
  private.runtime_feature_flag_receipts,
  private.capacity_monitor_configuration,
  private.capacity_monitor_snapshots,
  private.capacity_monitor_alert_state,
  private.capacity_monitor_budget_receipts
from public, anon, authenticated, service_role;

revoke all on function private.emit_system_notification_alert_unmetered(text,uuid,text),
  private.collect_capacity_monitor_snapshot_unmetered(boolean)
from public, anon, authenticated, service_role;
revoke all on function public.collect_capacity_monitor_snapshot(boolean),
  public.set_capacity_monitor_monthly_active_learner_budget(integer,text,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.collect_capacity_monitor_snapshot(boolean),
  public.set_capacity_monitor_monthly_active_learner_budget(integer,text,uuid)
to service_role;

comment on table private.capacity_monitor_snapshots is
  'One aggregate-only capacity snapshot per Asia/Oral day; it contains no participant-level values.';
comment on function public.collect_capacity_monitor_snapshot(boolean) is
  'Service-only monitoring receipt for the prototype monthly-active-learner budget; it does not limit signup, approval, or learning access.';
comment on function public.set_capacity_monitor_monthly_active_learner_budget(integer,text,uuid) is
  'Service-only, reasoned, idempotent update of the monthly active learner monitoring budget.';
