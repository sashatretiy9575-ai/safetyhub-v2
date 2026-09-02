-- Approval-request notifications are operational prompts, not application
-- records. New events deliberately carry only a versioned generic envelope so
-- the Telegram dispatcher and admin inbox do not receive contact details,
-- usernames, provider identities, or credentials.
--
-- Older rows remain immutable. The application and dispatcher retain narrow
-- compatibility parsers for those historical payloads until retention prunes
-- them naturally.

create or replace function private.emit_approval_requested_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locale public.app_locale;
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

  select profile.preferred_locale into v_locale
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
      'schemaVersion', 2,
      'locale', v_locale,
      'requestedAt', to_char(
        new.approval_requested_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'adminPath', '/admin/approvals'
    ),
    new.approval_requested_at
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

-- Requeue only deliveries that the earlier generic parser could not render:
-- the old exact five-key ZH envelope with intentionally blank name/surname.
-- This is service-only, bounded, lock-safe, and idempotent. It cannot touch a
-- delivery which may already have reached Telegram or which has an active
-- lease. The explicit payload predicates prevent broad dead-letter replay.
create function public.recover_legacy_blank_zh_approval_deliveries(
  p_limit integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recovered integer := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = 'check_violation',
      message = 'LEGACY_ZH_NOTIFICATION_RECOVERY_LIMIT_INVALID';
  end if;

  with candidates as (
    select delivery.id
    from private.notification_deliveries delivery
    join private.notification_events event on event.id = delivery.event_id
    where event.event_type = 'account.approval_requested'
      and delivery.status = 'dead'
      and delivery.remote_message_id is null
      and delivery.delivered_at is null
      and delivery.lease_token is null
      and delivery.lease_expires_at is null
      and jsonb_typeof(event.payload) = 'object'
      and (select count(*) from jsonb_object_keys(event.payload)) = 5
      and event.payload ?& array[
        'name', 'surname', 'locale', 'requestedAt', 'adminPath'
      ]
      and event.payload ->> 'name' = ''
      and event.payload ->> 'surname' = ''
      and event.payload ->> 'locale' = 'zh'
      and jsonb_typeof(event.payload -> 'requestedAt') = 'string'
      and event.payload ->> 'requestedAt' ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$'
      and jsonb_typeof(event.payload -> 'adminPath') = 'string'
      and event.payload ->> 'adminPath' ~ '^/admin(?:/|$)'
      and position(chr(92) in (event.payload ->> 'adminPath')) = 0
    order by delivery.updated_at, delivery.id
    limit p_limit
    for update of delivery skip locked
  ), recovered as (
    update private.notification_deliveries delivery
    set status = 'retry',
        attempts = 0,
        next_attempt_at = statement_timestamp(),
        lease_token = null,
        lease_expires_at = null,
        delivered_at = null,
        remote_message_id = null,
        last_error_category = null,
        updated_at = statement_timestamp()
    from candidates
    where delivery.id = candidates.id
    returning delivery.id
  )
  select count(*) into v_recovered from recovered;

  return jsonb_build_object('recovered', v_recovered);
end;
$$;

revoke all on function public.recover_legacy_blank_zh_approval_deliveries(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.recover_legacy_blank_zh_approval_deliveries(integer)
  to service_role;

comment on function private.emit_approval_requested_notification() is
  'Creates one schema-v2 generic no-PII approval notification per pending-review transition. The legacy telegram_application_details flag never expands newly-created payloads.';
comment on function public.recover_legacy_blank_zh_approval_deliveries(integer) is
  'Service-only bounded/idempotent recovery for exact dead legacy blank-ZH generic approval Telegram deliveries with no remote message and no lease.';
