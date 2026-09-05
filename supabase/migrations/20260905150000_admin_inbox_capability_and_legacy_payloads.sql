-- Уведомления администратора: доступ по умолчанию и чистые payload-ы.
--
-- Инбокс требовал capability audit.read, которая не выдаётся обычным админам
-- (admin_default = false) — колокольчик не появлялся ни у кого, кроме
-- superadmin. Открывать всем audit.read слишком широко (это ещё и страница
-- аудита), поэтому вводится узкая capability notifications.read с
-- admin_default = true; audit.read остаётся достаточной для совместимости.
--
-- Дополнительно удаляются legacy-события со старой схемой payload (ключ
-- userId): одна такая строка валит строгий zod-контракт и 500-ит весь инбокс.

insert into public.admin_capability_catalog
  (capability, category, label, admin_default, sensitive)
values
  ('notifications.read', 'audit', 'Уведомления администратора', true, false)
on conflict (capability) do update
set category = excluded.category,
    label = excluded.label,
    admin_default = excluded.admin_default,
    sensitive = excluded.sensitive;

create or replace function public.list_admin_notification_inbox(
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
  v_actor_id uuid := private.require_any_capability(
    array['notifications.read', 'audit.read']
  );
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

create or replace function public.mark_admin_notifications_read(
  p_event_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_any_capability(
    array['notifications.read', 'audit.read']
  );
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

create or replace function public.retry_admin_notification_delivery(
  p_event_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_any_capability(
    array['notifications.read', 'audit.read']
  );
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

revoke all on function public.list_admin_notification_inbox(integer,timestamptz,uuid),
  public.mark_admin_notifications_read(uuid[]),
  public.retry_admin_notification_delivery(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.list_admin_notification_inbox(
  integer,timestamptz,uuid
) to authenticated;
grant execute on function public.mark_admin_notifications_read(uuid[])
  to authenticated;
grant execute on function public.retry_admin_notification_delivery(uuid)
  to authenticated;

-- Legacy-события со старой схемой payload (до 20260902180000) содержат ключ
-- userId, который строгий контракт инбокса не принимает. Deliveries и reads
-- каскадируются.
delete from private.notification_events
where event_type = 'account.approval_requested'
  and payload ? 'userId';
