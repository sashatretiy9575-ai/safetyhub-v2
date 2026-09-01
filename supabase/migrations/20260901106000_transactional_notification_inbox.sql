-- Transactional product notification bus. It is intentionally separate from
-- private.auth_admin_outbox and contains only bounded, minimized payloads.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table private.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid,
  dedupe_key text not null unique,
  correlation_id uuid not null default gen_random_uuid(),
  payload jsonb not null,
  occurred_at timestamptz not null default statement_timestamp(),
  created_at timestamptz not null default statement_timestamp(),
  constraint notification_event_type check (
    event_type in (
      'account.approval_requested',
      'course.completed',
      'system.alert'
    )
  ),
  constraint notification_event_aggregate_type check (
    aggregate_type in ('account', 'attempt', 'system')
  ),
  constraint notification_event_dedupe_key_budget check (
    char_length(dedupe_key) between 1 and 240
    and dedupe_key !~ '[[:cntrl:]]'
  ),
  constraint notification_event_payload_budget check (
    jsonb_typeof(payload) = 'object'
    and pg_column_size(payload) <= 16384
  )
);

create index notification_events_inbox_idx
  on private.notification_events (occurred_at desc, id desc);
create index notification_events_retention_idx
  on private.notification_events (created_at, id);

create table private.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references private.notification_events(id) on delete cascade,
  channel text not null default 'telegram',
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default statement_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  remote_message_id text,
  last_error_category text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (event_id, channel),
  constraint notification_delivery_channel check (channel = 'telegram'),
  constraint notification_delivery_status check (
    status in ('pending', 'leased', 'retry', 'delivered', 'dead')
  ),
  constraint notification_delivery_attempts check (
    attempts between 0 and 10
  ),
  constraint notification_delivery_lease_shape check (
    (
      status = 'leased'
      and lease_token is not null
      and lease_expires_at is not null
      and delivered_at is null
    )
    or (
      status <> 'leased'
      and lease_token is null
      and lease_expires_at is null
    )
  ),
  constraint notification_delivery_delivered_shape check (
    (status = 'delivered' and delivered_at is not null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  constraint notification_delivery_remote_id_budget check (
    remote_message_id is null
    or char_length(remote_message_id) between 1 and 160
  ),
  constraint notification_delivery_error_category check (
    last_error_category is null
    or (
      char_length(last_error_category) between 1 and 64
      and last_error_category ~ '^[A-Z0-9_]+$'
    )
  )
);

create index notification_deliveries_claim_idx
  on private.notification_deliveries (next_attempt_at, id)
  where status in ('pending', 'retry', 'leased');
create index notification_deliveries_retention_idx
  on private.notification_deliveries (delivered_at, id)
  where status = 'delivered';

create table private.admin_notification_reads (
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null
    references private.notification_events(id) on delete cascade,
  read_at timestamptz not null default statement_timestamp(),
  primary key (admin_user_id, event_id)
);

create index admin_notification_reads_event_idx
  on private.admin_notification_reads (event_id, admin_user_id);

create function private.queue_notification_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.notification_deliveries(event_id, channel)
  values (new.id, 'telegram')
  on conflict (event_id, channel) do nothing;
  return new;
end;
$$;

create trigger notification_events_queue_delivery
after insert on private.notification_events
for each row execute function private.queue_notification_delivery();

create function private.emit_approval_requested_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
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
    jsonb_build_object(
      'userId', new.user_id,
      'name', v_profile.name,
      'surname', v_profile.surname,
      'locale', v_profile.preferred_locale,
      'requestedAt', new.approval_requested_at,
      'adminPath', '/admin/approvals'
    ),
    new.approval_requested_at
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create trigger account_controls_emit_approval_notification
after update of approval_state, approval_requested_at
on public.account_controls
for each row execute function private.emit_approval_requested_notification();

create function private.emit_course_completed_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_title text;
begin
  if old.status is not distinct from new.status
    or new.status not in ('passed', 'failed') then
    return new;
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = new.user_id;
  select localization.title into v_title
  from public.test_revision_localizations localization
  where localization.revision_id = new.revision_id
    and localization.locale = new.locale;
  if v_profile.id is null or v_title is null then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_EVENT_CONTEXT_MISSING';
  end if;

  insert into private.notification_events (
    event_type,
    aggregate_type,
    aggregate_id,
    dedupe_key,
    payload,
    occurred_at
  ) values (
    'course.completed',
    'attempt',
    new.id,
    'completion:' || new.id::text,
    jsonb_build_object(
      'attemptId', new.id,
      'userId', new.user_id,
      'name', v_profile.name,
      'surname', v_profile.surname,
      'locale', new.locale,
      'courseTitle', v_title,
      'result', new.status,
      'score', new.score,
      'total', (
        select variant.question_count
        from public.test_revision_variants variant
        where variant.id = new.variant_id
      ),
      'completedAt', new.completed_at,
      'adminPath', '/admin/attestations'
    ),
    coalesce(new.completed_at, statement_timestamp())
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create trigger test_attempts_emit_completion_notification
after update of status on public.test_attempts
for each row execute function private.emit_course_completed_notification();

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
declare
  v_event_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
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

create function public.list_admin_notification_inbox(
  p_limit integer default 30,
  p_before_occurred_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('audit.read');
  v_items jsonb;
  v_unread bigint;
begin
  if p_limit not between 1 and 50
    or ((p_before_occurred_at is null) <> (p_before_id is null)) then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_PAGE_INVALID';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'type', page.event_type,
    'correlationId', page.correlation_id,
    'payload', page.payload,
    'occurredAt', page.occurred_at,
    'readAt', page.read_at,
    'delivery', jsonb_build_object(
      'status', page.delivery_status,
      'attempts', page.delivery_attempts,
      'lastErrorCategory', page.last_error_category
    )
  ) order by page.occurred_at desc, page.id desc), '[]'::jsonb)
  into v_items
  from (
    select
      event.id,
      event.event_type,
      event.correlation_id,
      event.payload,
      event.occurred_at,
      reads.read_at,
      delivery.status as delivery_status,
      delivery.attempts as delivery_attempts,
      delivery.last_error_category
    from private.notification_events event
    left join private.admin_notification_reads reads
      on reads.event_id = event.id
     and reads.admin_user_id = v_actor_id
    left join private.notification_deliveries delivery
      on delivery.event_id = event.id
     and delivery.channel = 'telegram'
    where p_before_occurred_at is null
      or (event.occurred_at, event.id) <
        (p_before_occurred_at, p_before_id)
    order by event.occurred_at desc, event.id desc
    limit p_limit
  ) page;

  select count(*) into v_unread
  from private.notification_events event
  where not exists (
    select 1
    from private.admin_notification_reads reads
    where reads.admin_user_id = v_actor_id
      and reads.event_id = event.id
  );

  return jsonb_build_object(
    'items', v_items,
    'unread', v_unread,
    'serverNow', statement_timestamp()
  );
end;
$$;

create function public.mark_admin_notifications_read(
  p_event_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('audit.read');
  v_count integer;
begin
  if coalesce(cardinality(p_event_ids), 0) not between 1 and 100
    or cardinality(p_event_ids) <> (
      select count(distinct id)
      from unnest(coalesce(p_event_ids, '{}'::uuid[])) id
    ) then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_SELECTION_INVALID';
  end if;

  insert into private.admin_notification_reads(admin_user_id, event_id)
  select v_actor_id, event.id
  from private.notification_events event
  where event.id = any(p_event_ids)
  on conflict (admin_user_id, event_id) do update
  set read_at = excluded.read_at;
  get diagnostics v_count = row_count;
  return jsonb_build_object('marked', v_count);
end;
$$;

create function public.retry_admin_notification_delivery(
  p_event_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('audit.read');
  v_delivery private.notification_deliveries%rowtype;
begin
  select * into v_delivery
  from private.notification_deliveries delivery
  where delivery.event_id = p_event_id
    and delivery.channel = 'telegram'
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'NOTIFICATION_DELIVERY_NOT_FOUND';
  end if;
  if v_delivery.status not in ('dead', 'retry') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_DELIVERY_NOT_RETRYABLE';
  end if;

  update private.notification_deliveries
  set status = 'retry',
      attempts = 0,
      next_attempt_at = statement_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      delivered_at = null,
      remote_message_id = null,
      last_error_category = null,
      updated_at = statement_timestamp()
  where id = v_delivery.id;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'notification.delivery_retried',
    'notification_event',
    p_event_id::text,
    jsonb_build_object('channel', 'telegram')
  );
  return jsonb_build_object(
    'eventId', p_event_id,
    'status', 'retry'
  );
end;
$$;

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
declare
  v_items jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_worker_id is null
    or p_limit not between 1 and 50
    or p_lease_seconds not between 15 and 120 then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_CLAIM_INVALID';
  end if;

  -- An expired tenth lease is terminal. Without this transition the same row
  -- could be leased forever because the bounded attempts counter stays at 10.
  update private.notification_deliveries delivery
  set status = 'dead',
      lease_token = null,
      lease_expires_at = null,
      last_error_category = coalesce(
        delivery.last_error_category,
        'LEASE_EXHAUSTED'
      ),
      updated_at = statement_timestamp()
  where delivery.status = 'leased'
    and delivery.attempts >= 10
    and delivery.lease_expires_at <= statement_timestamp();

  with candidates as (
    select delivery.id
    from private.notification_deliveries delivery
    where delivery.attempts < 10
      and ((
      delivery.status in ('pending', 'retry')
      and delivery.next_attempt_at <= statement_timestamp()
    ) or (
      delivery.status = 'leased'
      and delivery.lease_expires_at <= statement_timestamp()
    ))
    order by delivery.next_attempt_at, delivery.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update private.notification_deliveries delivery
    set status = 'leased',
        attempts = least(delivery.attempts + 1, 10),
        lease_token = p_worker_id,
        lease_expires_at = statement_timestamp()
          + make_interval(secs => p_lease_seconds),
        last_error_category = null,
        updated_at = statement_timestamp()
    from candidates
    where delivery.id = candidates.id
    returning delivery.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'deliveryId', claimed.id,
    'leaseToken', claimed.lease_token,
    'attempt', claimed.attempts,
    'eventId', event.id,
    'eventType', event.event_type,
    'correlationId', event.correlation_id,
    'occurredAt', event.occurred_at,
    'payload', event.payload
  ) order by event.occurred_at, event.id), '[]'::jsonb)
  into v_items
  from claimed
  join private.notification_events event
    on event.id = claimed.event_id;
  return jsonb_build_object('items', v_items);
end;
$$;

create function public.complete_notification_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_remote_message_id text
)
returns boolean
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
  if p_remote_message_id is null
    or char_length(p_remote_message_id) not between 1 and 160 then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_COMPLETE_INVALID';
  end if;

  update private.notification_deliveries delivery
  set status = 'delivered',
      lease_token = null,
      lease_expires_at = null,
      delivered_at = statement_timestamp(),
      remote_message_id = p_remote_message_id,
      last_error_category = null,
      updated_at = statement_timestamp()
  where delivery.id = p_delivery_id
    and delivery.status = 'leased'
    and delivery.lease_token = p_lease_token;
  if found then return true; end if;

  return exists (
    select 1
    from private.notification_deliveries delivery
    where delivery.id = p_delivery_id
      and delivery.status = 'delivered'
      and delivery.remote_message_id = p_remote_message_id
  );
end;
$$;

create function public.fail_notification_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_error_category text,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery private.notification_deliveries%rowtype;
  v_delay integer;
  v_status text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_error_category is null
    or char_length(p_error_category) not between 1 and 64
    or p_error_category !~ '^[A-Z0-9_]+$'
    or (
      p_retry_after_seconds is not null
      and p_retry_after_seconds not between 1 and 86400
    ) then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_FAILURE_INVALID';
  end if;

  select * into v_delivery
  from private.notification_deliveries delivery
  where delivery.id = p_delivery_id
    and delivery.status = 'leased'
    and delivery.lease_token = p_lease_token
  for update;
  if not found then
    if exists (
      select 1 from private.notification_deliveries delivery
      where delivery.id = p_delivery_id
        and delivery.status in ('retry', 'dead')
        and delivery.last_error_category = p_error_category
    ) then
      select * into v_delivery
      from private.notification_deliveries delivery
      where delivery.id = p_delivery_id;
      return jsonb_build_object(
        'deliveryId', v_delivery.id,
        'status', v_delivery.status,
        'nextAttemptAt', v_delivery.next_attempt_at
      );
    end if;
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_LEASE_LOST';
  end if;

  v_status := case when v_delivery.attempts >= 10
    then 'dead' else 'retry' end;
  v_delay := coalesce(
    p_retry_after_seconds,
    least(3600, (15 * power(2, greatest(v_delivery.attempts - 1, 0)))::integer)
  );
  update private.notification_deliveries
  set status = v_status,
      next_attempt_at = case when v_status = 'dead'
        then next_attempt_at
        else statement_timestamp() + make_interval(secs => v_delay)
      end,
      lease_token = null,
      lease_expires_at = null,
      last_error_category = p_error_category,
      updated_at = statement_timestamp()
  where id = v_delivery.id
  returning * into v_delivery;
  return jsonb_build_object(
    'deliveryId', v_delivery.id,
    'status', v_delivery.status,
    'attempts', v_delivery.attempts,
    'nextAttemptAt', v_delivery.next_attempt_at
  );
end;
$$;

create function public.prune_notification_data(
  p_limit integer default 1000
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deliveries integer := 0;
  v_events integer := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_limit not between 1 and 5000 then
    raise exception using errcode = 'check_violation',
      message = 'NOTIFICATION_PRUNE_INVALID';
  end if;

  with expired as (
    select delivery.id
    from private.notification_deliveries delivery
    where delivery.status = 'delivered'
      and delivery.delivered_at < statement_timestamp() - interval '30 days'
    order by delivery.delivered_at, delivery.id
    limit p_limit
    for update skip locked
  )
  delete from private.notification_deliveries delivery
  using expired
  where delivery.id = expired.id;
  get diagnostics v_deliveries = row_count;

  with expired as (
    select event.id
    from private.notification_events event
    where event.created_at < statement_timestamp() - interval '90 days'
    order by event.created_at, event.id
    limit p_limit
    for update skip locked
  )
  delete from private.notification_events event
  using expired
  where event.id = expired.id;
  get diagnostics v_events = row_count;

  return jsonb_build_object(
    'deliveriesDeleted', v_deliveries,
    'eventsDeleted', v_events
  );
end;
$$;

create function private.request_notification_dispatch(
  p_reason text,
  p_delivery_id uuid default null
)
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
  if p_reason not in ('after_commit', 'scheduled') then
    return null;
  end if;
  begin
    execute $query$
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'notification_dispatch_url'
      limit 1
    $query$ into v_url;
    execute $query$
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'notification_dispatch_secret'
      limit 1
    $query$ into v_secret;
  exception when others then
    -- Missing Vault configuration is a dormant delivery state, never a
    -- reason to roll back the business transaction that created the event.
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
      body := jsonb_build_object(
        'reason', p_reason,
        'deliveryId', p_delivery_id,
        'requestedAt', statement_timestamp()
      ),
      timeout_milliseconds := 2000
    ) into v_request_id;
  exception when others then
    return null;
  end;
  return v_request_id;
end;
$$;

create function private.request_notification_dispatch_after_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.request_notification_dispatch('after_commit', new.id);
  return new;
end;
$$;

create trigger notification_deliveries_request_dispatch
after insert on private.notification_deliveries
for each row execute function private.request_notification_dispatch_after_insert();

-- Re-running this forward-only migration in an ephemeral/reset database keeps
-- one stable job name. pg_cron replaces the existing job with the same name.
select cron.schedule(
  'safetyhub-notification-dispatch',
  '* * * * *',
  'select private.request_notification_dispatch(''scheduled'', null);'
);

alter table private.notification_events enable row level security;
alter table private.notification_deliveries enable row level security;
alter table private.admin_notification_reads enable row level security;

revoke all on table private.notification_events,
  private.notification_deliveries,
  private.admin_notification_reads
from public, anon, authenticated, service_role;

revoke all on function private.queue_notification_delivery(),
  private.emit_approval_requested_notification(),
  private.emit_course_completed_notification(),
  private.request_notification_dispatch(text,uuid),
  private.request_notification_dispatch_after_insert()
from public, anon, authenticated, service_role;

revoke all on function public.emit_system_notification_alert(text,uuid,text),
  public.list_admin_notification_inbox(integer,timestamptz,uuid),
  public.mark_admin_notifications_read(uuid[]),
  public.retry_admin_notification_delivery(uuid),
  public.claim_notification_deliveries(uuid,integer,integer),
  public.complete_notification_delivery(uuid,uuid,text),
  public.fail_notification_delivery(uuid,uuid,text,integer),
  public.prune_notification_data(integer)
from public, anon, authenticated, service_role;

grant execute on function public.list_admin_notification_inbox(
  integer,timestamptz,uuid
) to authenticated;
grant execute on function public.mark_admin_notifications_read(uuid[])
  to authenticated;
grant execute on function public.retry_admin_notification_delivery(uuid)
  to authenticated;
grant execute on function public.emit_system_notification_alert(text,uuid,text),
  public.claim_notification_deliveries(uuid,integer,integer),
  public.complete_notification_delivery(uuid,uuid,text),
  public.fail_notification_delivery(uuid,uuid,text,integer),
  public.prune_notification_data(integer)
to service_role;

comment on table private.notification_events is
  'Locale-neutral minimized product events retained for 90 days and rendered in Russian by the admin inbox/Telegram dispatcher.';
comment on table private.notification_deliveries is
  'Lease-based idempotent external delivery state; delivered rows are retained for 30 days.';
comment on function public.claim_notification_deliveries(uuid,integer,integer) is
  'Service-only bounded SKIP LOCKED claim used by immediate and scheduled Telegram dispatch.';
