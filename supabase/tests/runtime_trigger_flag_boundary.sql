begin;

do $contract$
declare
  v_role name;
  v_trigger record;
begin
  foreach v_role in array array['anon'::name, 'authenticated'::name, 'service_role'::name]
  loop
    if has_function_privilege(
      v_role,
      'private.runtime_feature_enabled(text)',
      'execute'
    ) or has_function_privilege(
      v_role,
      'private.emit_approval_requested_notification()',
      'execute'
    ) or has_function_privilege(
      v_role,
      'private.emit_course_completed_notification()',
      'execute'
    ) or has_function_privilege(
      v_role,
      'private.request_notification_dispatch_after_insert()',
      'execute'
    ) then
      raise exception '% can execute a private runtime trigger helper', v_role;
    end if;
  end loop;

  for v_trigger in
    select
      trigger.tgname,
      pg_get_triggerdef(trigger.oid) as definition,
      function.prosecdef,
      function.proname
    from pg_trigger trigger
    join pg_proc function on function.oid = trigger.tgfoid
    where not trigger.tgisinternal
      and trigger.tgname in (
        'account_controls_emit_approval_notification',
        'test_attempts_emit_completion_notification',
        'notification_deliveries_request_dispatch'
      )
  loop
    if v_trigger.definition ilike '% when %'
      or not v_trigger.prosecdef then
      raise exception 'runtime trigger % exposes an invoker-side flag lookup: %',
        v_trigger.tgname, v_trigger.definition;
    end if;
  end loop;

  if (select count(*)
      from pg_trigger trigger
      where not trigger.tgisinternal
        and trigger.tgname in (
          'account_controls_emit_approval_notification',
          'test_attempts_emit_completion_notification',
          'notification_deliveries_request_dispatch'
        )) <> 3 then
    raise exception 'runtime trigger set is incomplete';
  end if;

  if position(
    'runtime_feature_enabled(''notification_events'')'
    in pg_get_functiondef(
      'private.emit_approval_requested_notification()'::regprocedure
    )
  ) = 0 or position(
    'runtime_feature_enabled(''notification_events'')'
    in pg_get_functiondef(
      'private.emit_course_completed_notification()'::regprocedure
    )
  ) = 0 or position(
    'runtime_feature_enabled(''telegram_delivery'')'
    in pg_get_functiondef(
      'private.request_notification_dispatch_after_insert()'::regprocedure
    )
  ) = 0 then
    raise exception 'runtime flag checks are not inside all trigger definers';
  end if;
end;
$contract$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '7c000000-0000-4000-8000-000000000101',
  'authenticated',
  'authenticated',
  'runtime-trigger-boundary@example.com',
  '',
  statement_timestamp(),
  '{}'::jsonb,
  '{}'::jsonb,
  statement_timestamp(),
  statement_timestamp()
);

update public.profiles
set name = 'Тест', surname = 'Граница', preferred_locale = 'ru'
where id = '7c000000-0000-4000-8000-000000000101';

-- A direct service-only maintenance write must not need EXECUTE on the private
-- flag reader. With the flag disabled it succeeds without emitting an event.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
update public.account_controls
set approval_state = 'pending',
    approval_requested_at = statement_timestamp(),
    approval_due_at = statement_timestamp() + interval '24 hours'
where user_id = '7c000000-0000-4000-8000-000000000101';
reset role;

do $disabled$
begin
  if exists (
    select 1
    from private.notification_events event
    where event.aggregate_id = '7c000000-0000-4000-8000-000000000101'
  ) then
    raise exception 'disabled notification trigger emitted an event';
  end if;
end;
$disabled$;

update private.runtime_feature_flags
set enabled = true, updated_at = statement_timestamp()
where feature_name = 'notification_events';

-- The same service-role statement now takes the positive path through the
-- SECURITY DEFINER wrapper while the helper itself remains inaccessible.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
update public.account_controls
set approval_requested_at = approval_requested_at + interval '1 second',
    approval_due_at = approval_due_at + interval '1 second'
where user_id = '7c000000-0000-4000-8000-000000000101';
reset role;

do $enabled$
begin
  if (select count(*)
      from private.notification_events event
      where event.aggregate_id = '7c000000-0000-4000-8000-000000000101'
        and event.event_type = 'account.approval_requested') <> 1 then
    raise exception 'enabled service-role trigger did not emit exactly one event';
  end if;
  if (select count(*)
      from private.notification_deliveries delivery
      join private.notification_events event on event.id = delivery.event_id
      where event.aggregate_id = '7c000000-0000-4000-8000-000000000101') <> 1 then
    raise exception 'enabled event did not create exactly one delivery';
  end if;
end;
$enabled$;

rollback;
