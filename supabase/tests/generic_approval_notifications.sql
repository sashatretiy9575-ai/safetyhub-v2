begin;

do $test$
declare
  v_candidate_event_id uuid;
  v_candidate_delivery_id uuid;
  v_delivered_event_id uuid;
  v_remote_event_id uuid;
  v_leased_event_id uuid;
  v_non_zh_event_id uuid;
  v_extra_key_event_id uuid;
  v_result jsonb;
  v_rejected boolean := false;
  v_legacy_blank_zh jsonb := jsonb_build_object(
    'name', '',
    'surname', '',
    'locale', 'zh',
    'requestedAt', '2026-09-02T12:00:00Z',
    'adminPath', '/admin/approvals'
  );
begin
  if to_regprocedure(
    'public.recover_legacy_blank_zh_approval_deliveries(integer)'
  ) is null then
    raise exception 'legacy ZH notification recovery RPC is missing';
  end if;
  if has_function_privilege(
    'anon',
    'public.recover_legacy_blank_zh_approval_deliveries(integer)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.recover_legacy_blank_zh_approval_deliveries(integer)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.recover_legacy_blank_zh_approval_deliveries(integer)',
    'execute'
  ) then
    raise exception 'legacy ZH notification recovery grants are unsafe';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  insert into private.notification_events (
    event_type, aggregate_type, dedupe_key, payload
  ) values
    ('account.approval_requested', 'account', 'legacy-blank-zh-recoverable', v_legacy_blank_zh),
    ('account.approval_requested', 'account', 'legacy-blank-zh-delivered', v_legacy_blank_zh),
    ('account.approval_requested', 'account', 'legacy-blank-zh-remote', v_legacy_blank_zh),
    ('account.approval_requested', 'account', 'legacy-blank-zh-leased', v_legacy_blank_zh),
    (
      'account.approval_requested',
      'account',
      'legacy-blank-ru-dead',
      jsonb_set(v_legacy_blank_zh, '{locale}', '"ru"'::jsonb)
    ),
    (
      'account.approval_requested',
      'account',
      'legacy-blank-zh-extra-key',
      jsonb_set(v_legacy_blank_zh, '{schemaVersion}', '1'::jsonb)
    );

  -- Resolve every fixture through deterministic dedupe keys without exposing
  -- any profile data.
  select id into v_candidate_event_id
  from private.notification_events
  where dedupe_key = 'legacy-blank-zh-recoverable';
  select id into v_delivered_event_id
  from private.notification_events
  where dedupe_key = 'legacy-blank-zh-delivered';
  select id into v_remote_event_id
  from private.notification_events
  where dedupe_key = 'legacy-blank-zh-remote';
  select id into v_leased_event_id
  from private.notification_events
  where dedupe_key = 'legacy-blank-zh-leased';
  select id into v_non_zh_event_id
  from private.notification_events
  where dedupe_key = 'legacy-blank-ru-dead';
  select id into v_extra_key_event_id
  from private.notification_events
  where dedupe_key = 'legacy-blank-zh-extra-key';

  select id into v_candidate_delivery_id
  from private.notification_deliveries
  where event_id = v_candidate_event_id;

  update private.notification_deliveries
  set status = 'dead',
      attempts = 10,
      last_error_category = 'NOTIFICATION_PAYLOAD_INVALID',
      lease_token = null,
      lease_expires_at = null,
      delivered_at = null,
      remote_message_id = null
  where event_id in (v_candidate_event_id, v_remote_event_id, v_non_zh_event_id, v_extra_key_event_id);

  update private.notification_deliveries
  set status = 'delivered',
      attempts = 1,
      lease_token = null,
      lease_expires_at = null,
      delivered_at = statement_timestamp(),
      remote_message_id = 'telegram-delivered-fixture',
      last_error_category = null
  where event_id = v_delivered_event_id;

  update private.notification_deliveries
  set remote_message_id = 'telegram-remote-fixture'
  where event_id = v_remote_event_id;

  update private.notification_deliveries
  set status = 'leased',
      attempts = 1,
      lease_token = '7e000000-0000-4000-8000-000000000001',
      lease_expires_at = statement_timestamp() + interval '10 minutes',
      delivered_at = null,
      remote_message_id = null,
      last_error_category = null
  where event_id = v_leased_event_id;

  v_result := public.recover_legacy_blank_zh_approval_deliveries(100);
  if v_result ->> 'recovered' <> '1'
    or not exists (
      select 1
      from private.notification_deliveries delivery
      where delivery.id = v_candidate_delivery_id
        and delivery.status = 'retry'
        and delivery.attempts = 0
        and delivery.lease_token is null
        and delivery.lease_expires_at is null
        and delivery.remote_message_id is null
        and delivery.delivered_at is null
        and delivery.last_error_category is null
    ) then
    raise exception 'exact dead blank-ZH delivery was not safely recovered: %', v_result;
  end if;

  if exists (
    select 1
    from private.notification_deliveries delivery
    where (delivery.event_id = v_delivered_event_id and delivery.status <> 'delivered')
       or (delivery.event_id = v_remote_event_id and delivery.status <> 'dead')
       or (delivery.event_id = v_leased_event_id and delivery.status <> 'leased')
       or (delivery.event_id = v_non_zh_event_id and delivery.status <> 'dead')
       or (delivery.event_id = v_extra_key_event_id and delivery.status <> 'dead')
  ) then
    raise exception 'legacy ZH recovery touched a non-candidate delivery';
  end if;

  if public.recover_legacy_blank_zh_approval_deliveries(100) ->> 'recovered' <> '0' then
    raise exception 'legacy ZH recovery is not idempotent';
  end if;

  begin
    perform public.recover_legacy_blank_zh_approval_deliveries(101);
  exception when check_violation then
    v_rejected := sqlerrm = 'LEGACY_ZH_NOTIFICATION_RECOVERY_LIMIT_INVALID';
  end;
  if not v_rejected then
    raise exception 'legacy ZH recovery limit is not bounded';
  end if;
end;
$test$;

rollback;
