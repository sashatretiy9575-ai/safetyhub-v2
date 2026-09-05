begin;

do $test$
declare
  v_actor_id uuid := gen_random_uuid();
  v_new_user_id uuid := gen_random_uuid();
  v_email text := 'pending-grant-target@safetyhub.invalid';
  v_second_email text := 'pending-grant-second@safetyhub.invalid';
  v_result jsonb;
  v_event_id uuid;
  v_blocked boolean;
begin
  -- Actor: a superadmin (role.manage is not an admin default capability).
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_actor_id,
    'authenticated', 'authenticated', 'pending-grant-actor@safetyhub.invalid', '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  );
  update public.user_roles set role = 'superadmin' where user_id = v_actor_id;
  perform set_config('request.jwt.claim.sub', v_actor_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- An unknown email is not refused any more: the appointment is parked.
  v_result := public.set_product_role_by_email(
    gen_random_uuid(), '  ' || upper(v_email) || ' ', 'admin',
    'Новый специалист, ещё не входил на сайт'
  );
  if (v_result ->> 'pending')::boolean is not true
    or not exists (
      select 1 from private.pending_admin_grants
      where normalized_email = v_email
    ) then
    raise exception 'pending admin grant was not stored: %', v_result;
  end if;
  if (public.list_pending_admin_grants() #>> '{items,0,email}') <> v_email then
    raise exception 'pending admin grant is not listed';
  end if;

  -- First sign-in with that email applies the grant and audits it.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_new_user_id,
    'authenticated', 'authenticated', v_email, '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  );
  if not exists (
    select 1 from public.user_roles
    where user_id = v_new_user_id and product_role = 'admin' and role = 'admin'
  ) or exists (
    select 1 from private.pending_admin_grants where normalized_email = v_email
  ) or not exists (
    select 1 from public.admin_audit_log
    where action = 'role.changed'
      and target_user_id = v_new_user_id
      and actor_user_id = v_actor_id
  ) or exists (
    select 1 from public.admin_audit_log
    where action = 'role.changed_directly' and target_user_id = v_new_user_id
  ) then
    raise exception 'pending admin grant was not applied on first sign-in';
  end if;

  -- A parked appointment can be withdrawn with the participant role.
  perform public.set_product_role_by_email(
    gen_random_uuid(), v_second_email, 'admin', 'Второе отложенное назначение'
  );
  perform public.set_product_role_by_email(
    gen_random_uuid(), v_second_email, 'participant', 'Отмена отложенного назначения'
  );
  if exists (
    select 1 from private.pending_admin_grants where normalized_email = v_second_email
  ) then
    raise exception 'pending admin grant was not withdrawn';
  end if;

  -- Unknown email + participant is still a refusal, not a silent success.
  v_blocked := false;
  begin
    perform public.set_product_role_by_email(
      gen_random_uuid(), 'never-registered@safetyhub.invalid', 'participant',
      'Нет ни аккаунта, ни назначения'
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'participant demotion of an unknown email was accepted';
  end if;

  -- Synthetic ZH addresses can never be parked as future operators.
  v_blocked := false;
  begin
    perform public.set_product_role_by_email(
      gen_random_uuid(), 'zh-user@auth.invalid', 'admin', 'Попытка назначить синтетический вход'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'a synthetic zh address was parked as a pending admin';
  end if;

  -- «Прочитать всё» ставит отметку даже на событие, которое интерфейс не
  -- отображает, и повторный вызов ничего не добавляет.
  insert into private.notification_events (
    event_type, aggregate_type, aggregate_id, dedupe_key, correlation_id, payload
  ) values (
    'system.alert', 'system', null, 'read-all-test:' || gen_random_uuid(),
    gen_random_uuid(), '{"unrenderable": true}'::jsonb
  ) returning id into v_event_id;
  v_result := public.mark_all_admin_notifications_read();
  if (v_result ->> 'marked')::integer < 1
    or not exists (
      select 1 from private.admin_notification_reads
      where admin_user_id = v_actor_id and event_id = v_event_id
    ) then
    raise exception 'mark-all did not cover every event: %', v_result;
  end if;
  v_result := public.mark_all_admin_notifications_read();
  if (v_result ->> 'marked')::integer <> 0 then
    raise exception 'mark-all is not idempotent: %', v_result;
  end if;

  -- Grants: only authenticated may call the new RPCs.
  if not has_function_privilege(
      'authenticated', 'public.list_pending_admin_grants()', 'EXECUTE')
    or has_function_privilege('anon', 'public.list_pending_admin_grants()', 'EXECUTE')
    or has_function_privilege('service_role', 'public.list_pending_admin_grants()', 'EXECUTE')
    or not has_function_privilege(
      'authenticated', 'public.mark_all_admin_notifications_read()', 'EXECUTE')
    or has_function_privilege('anon', 'public.mark_all_admin_notifications_read()', 'EXECUTE') then
    raise exception 'pending-grant/read-all RPC grants are wrong';
  end if;
end;
$test$;

rollback;
