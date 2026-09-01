begin;

do $test$
declare
  v_user_id uuid := '7c000000-0000-4000-8000-000000000001';
  v_requested_at timestamptz := statement_timestamp();
  v_result jsonb;
  v_failed boolean;
begin
  if to_regclass('private.runtime_feature_flags') is null
    or to_regclass('private.runtime_feature_flag_receipts') is null
    or to_regprocedure('public.set_runtime_feature_flag(text,boolean,text,uuid)') is null then
    raise exception 'runtime rollout schema is incomplete';
  end if;
  if has_table_privilege('anon', 'private.runtime_feature_flags', 'select')
    or has_table_privilege('authenticated', 'private.runtime_feature_flags', 'select')
    or has_table_privilege('service_role', 'private.runtime_feature_flags', 'select')
    or has_function_privilege(
      'authenticated', 'public.set_runtime_feature_flag(text,boolean,text,uuid)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.set_runtime_feature_flag(text,boolean,text,uuid)', 'execute'
    ) then
    raise exception 'runtime rollout grants are unsafe';
  end if;
  if private.runtime_feature_enabled('notification_events')
    or private.runtime_feature_enabled('telegram_delivery') then
    raise exception 'runtime rollout defaults are not fail-closed';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user_id,
    'authenticated', 'authenticated', 'rollout-user@example.com', '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  );
  update public.profiles
  set name = 'Тест', surname = 'Флаг', preferred_locale = 'ru'
  where id = v_user_id;
  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours'
  where user_id = v_user_id;
  if exists (
    select 1 from private.notification_events event
    where event.aggregate_id = v_user_id
  ) then
    raise exception 'disabled event trigger emitted an event';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_failed := false;
  begin
    perform public.set_runtime_feature_flag(
      'telegram_delivery', true, 'Invalid dependency order test',
      '7c000000-0000-4000-8000-000000000010'
    );
  exception when object_not_in_prerequisite_state then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Telegram enabled before notification events';
  end if;

  v_result := public.set_runtime_feature_flag(
    'notification_events', true, 'Enable event emission for release test',
    '7c000000-0000-4000-8000-000000000011'
  );
  if v_result ->> 'enabled' <> 'true' or v_result ->> 'changed' <> 'true' then
    raise exception 'notification feature enable receipt is invalid: %', v_result;
  end if;
  if public.set_runtime_feature_flag(
    'notification_events', true, 'Enable event emission for release test',
    '7c000000-0000-4000-8000-000000000011'
  ) is distinct from v_result then
    raise exception 'runtime feature request is not idempotent';
  end if;

  update public.account_controls
  set approval_requested_at = v_requested_at + interval '1 second'
  where user_id = v_user_id;
  if (select count(*) from private.notification_events event
      where event.aggregate_id = v_user_id) <> 1 then
    raise exception 'enabled event trigger did not emit exactly once';
  end if;

  v_result := public.claim_notification_deliveries(
    '7c000000-0000-4000-8000-000000000099', 20, 45
  );
  if jsonb_array_length(v_result -> 'items') <> 0 then
    raise exception 'disabled Telegram gate returned deliveries: %', v_result;
  end if;

  perform public.set_runtime_feature_flag(
    'telegram_delivery', true, 'Enable Telegram delivery for release test',
    '7c000000-0000-4000-8000-000000000012'
  );
  v_result := public.claim_notification_deliveries(
    '7c000000-0000-4000-8000-000000000099', 20, 45
  );
  if jsonb_array_length(v_result -> 'items') <> 1 then
    raise exception 'enabled Telegram gate did not return delivery: %', v_result;
  end if;

  v_failed := false;
  begin
    perform public.set_runtime_feature_flag(
      'notification_events', false, 'Invalid dependency disable test',
      '7c000000-0000-4000-8000-000000000013'
    );
  exception when object_not_in_prerequisite_state then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'notification events disabled before Telegram';
  end if;
end;
$test$;

rollback;
