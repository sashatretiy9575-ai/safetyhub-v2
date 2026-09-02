begin;

do $test$
declare
  v_user_id uuid := '7b000000-0000-4000-8000-000000000001';
  v_admin_id uuid := '7b000000-0000-4000-8000-000000000002';
  v_requested_at timestamptz := statement_timestamp();
  v_event_id uuid;
  v_delivery_id uuid;
  v_claim jsonb;
  v_result jsonb;
  v_payload jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform public.set_runtime_feature_flag(
    'notification_events', true, 'Enable notification contract test',
    '7b000000-0000-4000-8000-000000000090'
  );
  perform public.set_runtime_feature_flag(
    'telegram_delivery', true, 'Enable Telegram delivery contract test',
    '7b000000-0000-4000-8000-000000000091'
  );

  if to_regclass('private.notification_events') is null
    or to_regclass('private.notification_deliveries') is null
    or to_regclass('private.admin_notification_reads') is null then
    raise exception 'notification inbox schema is incomplete';
  end if;

  if has_table_privilege('anon', 'private.notification_events', 'select')
    or has_table_privilege('authenticated', 'private.notification_events', 'select')
    or has_table_privilege('service_role', 'private.notification_events', 'select')
    or has_table_privilege('anon', 'private.notification_deliveries', 'select')
    or has_table_privilege('authenticated', 'private.notification_deliveries', 'select')
    or has_table_privilege('service_role', 'private.notification_deliveries', 'select') then
    raise exception 'notification private tables have direct role grants';
  end if;

  if has_function_privilege(
    'anon', 'public.list_admin_notification_inbox(integer,timestamptz,uuid)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.list_admin_notification_inbox(integer,timestamptz,uuid)', 'execute'
  ) or has_function_privilege(
    'authenticated', 'public.claim_notification_deliveries(uuid,integer,integer)', 'execute'
  ) or not has_function_privilege(
    'service_role', 'public.claim_notification_deliveries(uuid,integer,integer)', 'execute'
  ) then
    raise exception 'notification RPC grants are unsafe';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_user_id,
      'authenticated', 'authenticated', 'notification-user@example.com', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_admin_id,
      'authenticated', 'authenticated', 'notification-admin@example.com', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );
  update public.user_roles set role = 'admin' where user_id = v_admin_id;
  update public.profiles
  set name = 'Иван', surname = 'Тестов', preferred_locale = 'kk'
  where id = v_user_id;

  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours',
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_user_id;

  select event.id, event.payload
  into v_event_id, v_payload
  from private.notification_events event
  where event.event_type = 'account.approval_requested'
    and event.aggregate_id = v_user_id;
  if v_event_id is null
    or v_payload ->> 'schemaVersion' <> '2'
    or (select count(*) from jsonb_object_keys(v_payload)) <> 4
    or v_payload ->> 'locale' <> 'kk'
    or v_payload ->> 'adminPath' <> '/admin/approvals'
    or v_payload ? 'name'
    or v_payload ? 'surname'
    or v_payload::text ~* 'email|phone|job|organization|credential|answer|username' then
    raise exception 'approval event is missing or contains prohibited PII: %', v_payload;
  end if;
  if (select count(*) from private.notification_deliveries delivery
      where delivery.event_id = v_event_id) <> 1 then
    raise exception 'approval event did not create exactly one delivery';
  end if;

  -- Repeating the same state/timestamp is not a second business event.
  update public.account_controls
  set approval_state = 'pending'
  where user_id = v_user_id;
  if (select count(*) from private.notification_events event
      where event.aggregate_id = v_user_id
        and event.event_type = 'account.approval_requested') <> 1 then
    raise exception 'approval event dedupe contract failed';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_result := public.list_admin_notification_inbox(30, null, null);
  if (v_result ->> 'unread')::integer < 1
    or not exists (
      select 1 from jsonb_array_elements(v_result -> 'items') item(value)
      where item.value ->> 'id' = v_event_id::text
    ) then
    raise exception 'admin inbox did not return the transactional event: %', v_result;
  end if;
  perform public.mark_admin_notifications_read(array[v_event_id]);
  v_result := public.list_admin_notification_inbox(30, null, null);
  if (v_result ->> 'unread')::integer <> 0 then
    raise exception 'admin notification read receipt did not update';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_claim := public.claim_notification_deliveries(
    '7b000000-0000-4000-8000-000000000099', 20, 45
  );
  select
    (item.value ->> 'deliveryId')::uuid,
    item.value
  into v_delivery_id, v_result
  from jsonb_array_elements(v_claim -> 'items') item(value)
  where item.value ->> 'eventId' = v_event_id::text;
  if v_delivery_id is null
    or v_result ->> 'eventType' <> 'account.approval_requested' then
    raise exception 'service claim did not return the expected delivery: %', v_claim;
  end if;
  if not public.complete_notification_delivery(
    v_delivery_id,
    '7b000000-0000-4000-8000-000000000099',
    'telegram-message-1'
  ) then
    raise exception 'notification completion was not accepted';
  end if;
  if not public.complete_notification_delivery(
    v_delivery_id,
    '7b000000-0000-4000-8000-000000000099',
    'telegram-message-1'
  ) then
    raise exception 'notification completion was not idempotent';
  end if;

  update private.notification_deliveries
  set status = 'leased', attempts = 10,
      lease_token = '7b000000-0000-4000-8000-000000000098',
      lease_expires_at = statement_timestamp() - interval '1 second',
      delivered_at = null, remote_message_id = null
  where id = v_delivery_id;
  perform public.claim_notification_deliveries(
    '7b000000-0000-4000-8000-000000000097', 20, 45
  );
  if (select status from private.notification_deliveries where id = v_delivery_id)
      <> 'dead' then
    raise exception 'exhausted expired lease did not transition to dead letter';
  end if;
end;
$test$;

rollback;
