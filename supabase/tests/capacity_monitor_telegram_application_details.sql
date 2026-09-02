begin;

do $contract$
declare
  v_result jsonb;
  v_failed boolean;
  v_user_id uuid := '7d000000-0000-4000-8000-000000000001';
  v_requested_at timestamptz := statement_timestamp();
  v_revision_id uuid;
  v_test_id uuid;
  v_variant_id uuid;
  v_duration_minutes integer;
  v_pass_score integer;
  v_attempts_per_day integer;
  v_reset_timezone text;
  v_runtime_feature_flag_definition text;
begin
  if to_regclass('private.capacity_monitor_configuration') is null
    or to_regclass('private.capacity_monitor_snapshots') is null
    or to_regclass('private.capacity_monitor_alert_state') is null
    or to_regprocedure('public.collect_capacity_monitor_snapshot(boolean)') is null
    or to_regprocedure(
      'public.set_capacity_monitor_monthly_active_learner_budget(integer,text,uuid)'
    ) is null then
    raise exception 'capacity monitor schema is incomplete';
  end if;
  if has_table_privilege('anon', 'private.capacity_monitor_snapshots', 'select')
    or has_table_privilege('authenticated', 'private.capacity_monitor_snapshots', 'select')
    or has_table_privilege('service_role', 'private.capacity_monitor_snapshots', 'select')
    or has_function_privilege(
      'authenticated', 'public.collect_capacity_monitor_snapshot(boolean)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.collect_capacity_monitor_snapshot(boolean)', 'execute'
    ) then
    raise exception 'capacity monitor grants are unsafe';
  end if;
  if private.runtime_feature_enabled('telegram_application_details') then
    raise exception 'full Telegram application delivery defaults are not fail-closed';
  end if;
  v_runtime_feature_flag_definition := pg_get_functiondef(
    'public.set_runtime_feature_flag(text,boolean,text,uuid)'::regprocedure
  );
  if position(
    'safetyhub.runtime_feature_flags.v1' in v_runtime_feature_flag_definition
  ) = 0
    or position(
      'p_idempotency_key::text' in v_runtime_feature_flag_definition
    ) = 0
    or position(
      'safetyhub.runtime_feature_flags.v1' in v_runtime_feature_flag_definition
    ) >= position(
      'p_idempotency_key::text' in v_runtime_feature_flag_definition
    ) then
    raise exception 'runtime feature dependency transitions are not globally serialized';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_failed := false;
  begin
    perform public.set_runtime_feature_flag(
      'telegram_application_details', true,
      'Reject details before Telegram delivery is ready',
      '7d000000-0000-4000-8000-000000000010'
    );
  exception when object_not_in_prerequisite_state then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'full Telegram application details enabled without dependencies';
  end if;

  perform public.set_runtime_feature_flag(
    'notification_events', true,
    'Enable event emission for capacity contract',
    '7d000000-0000-4000-8000-000000000011'
  );
  perform public.set_runtime_feature_flag(
    'telegram_delivery', true,
    'Enable Telegram delivery for capacity contract',
    '7d000000-0000-4000-8000-000000000012'
  );
  perform public.set_runtime_feature_flag(
    'telegram_application_details', true,
    'Exercise legacy details flag without expanding new payloads',
    '7d000000-0000-4000-8000-000000000013'
  );

  v_result := public.collect_capacity_monitor_snapshot(true);
  if v_result -> 'metrics' ->> 'monthlyActiveLearnerLimit' <> '100'
    or v_result -> 'metrics' ->> 'timezone' <> 'Asia/Oral'
    or not (v_result ? 'capturedDay') then
    raise exception 'capacity snapshot contract is invalid: %', v_result;
  end if;
  if public.collect_capacity_monitor_snapshot(false) ->> 'alreadyCaptured' <> 'true' then
    raise exception 'capacity snapshot idempotency is invalid';
  end if;

  v_result := public.set_capacity_monitor_monthly_active_learner_budget(
    120,
    'Adjust prototype capacity monitor contract budget',
    '7d000000-0000-4000-8000-000000000014'
  );
  if v_result ->> 'monthlyActiveLearnerLimit' <> '120'
    or v_result ->> 'changed' <> 'true' then
    raise exception 'capacity budget receipt is invalid: %', v_result;
  end if;
  if public.set_capacity_monitor_monthly_active_learner_budget(
    120,
    'Adjust prototype capacity monitor contract budget',
    '7d000000-0000-4000-8000-000000000014'
  ) is distinct from v_result then
    raise exception 'capacity budget request is not idempotent';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user_id,
    'authenticated', 'authenticated', 'application-contract@example.com', '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  );
  update public.profiles
  set name = 'Тест',
      surname = 'Заявка',
      job = 'Инженер',
      organization = 'SafetyHub',
      phone_country_iso2 = 'KZ',
      phone_e164 = '+77010000000',
      preferred_locale = 'zh'
  where id = v_user_id;
  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours'
  where user_id = v_user_id;

  if not exists (
    select 1
    from private.notification_events event
    where event.aggregate_id = v_user_id
      and event.event_type = 'account.approval_requested'
      and event.payload ->> 'schemaVersion' = '2'
      and (select count(*) from jsonb_object_keys(event.payload)) = 4
      and event.payload ?& array[
        'schemaVersion', 'locale', 'requestedAt', 'adminPath'
      ]
      and not event.payload ? 'email'
      and not event.payload ? 'userId'
      and not event.payload ? 'name'
      and not event.payload ? 'surname'
      and not event.payload ? 'username'
      and not event.payload ? 'credential'
      and not event.payload ? 'job'
      and not event.payload ? 'organization'
      and not event.payload ? 'phoneCountryIso2'
      and not event.payload ? 'phoneE164'
  ) then
    raise exception 'new Telegram approval payload is not generic no-PII v2';
  end if;

  select
    revision.id,
    revision.test_id,
    variant.id,
    revision.duration_minutes,
    revision.pass_score,
    revision.attempts_per_calendar_day,
    revision.attempt_reset_timezone
  into
    v_revision_id,
    v_test_id,
    v_variant_id,
    v_duration_minutes,
    v_pass_score,
    v_attempts_per_day,
    v_reset_timezone
  from public.test_revisions revision
  join public.test_revision_variants variant on variant.revision_id = revision.id
  order by revision.published_at, revision.id, variant.id
  limit 1;
  if not found then
    raise exception 'capacity monitor contract requires one seeded course variant';
  end if;

  insert into public.test_attempts (
    user_id,
    revision_id,
    test_id,
    variant_id,
    locale,
    duration_minutes,
    pass_score,
    attempts_per_day,
    reset_timezone,
    started_at,
    expires_at
  ) values (
    v_user_id,
    v_revision_id,
    v_test_id,
    v_variant_id,
    'zh',
    v_duration_minutes,
    v_pass_score,
    v_attempts_per_day,
    v_reset_timezone,
    statement_timestamp(),
    statement_timestamp() + make_interval(mins => v_duration_minutes)
  );

  perform public.set_capacity_monitor_monthly_active_learner_budget(
    1,
    'Exercise no-JWT capacity scheduler alert path',
    '7d000000-0000-4000-8000-000000000015'
  );
  perform set_config('request.jwt.claim.role', '', true);
  v_result := private.collect_capacity_monitor_snapshot_unmetered(true);
  if v_result ->> 'alerted' <> 'true'
    or not exists (
      select 1
      from private.notification_events event
      where event.event_type = 'system.alert'
        and event.payload ->> 'machineCode' = 'CAPACITY_MAU_95'
    ) then
    raise exception 'capacity scheduler cannot emit a no-JWT alert: %', v_result;
  end if;
end;
$contract$;

rollback;
