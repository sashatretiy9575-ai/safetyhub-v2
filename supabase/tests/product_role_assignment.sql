begin;

do $test$
declare
  v_admin uuid;
  v_target uuid;
  v_email text;
  v_role text;
  v_definition text;
  v_key uuid := gen_random_uuid();
begin
  if not has_function_privilege(
       'authenticated',
       'public.set_product_role_by_email(uuid,text,public.product_role,text)', 'EXECUTE')
    or has_function_privilege(
       'anon',
       'public.set_product_role_by_email(uuid,text,public.product_role,text)', 'EXECUTE')
    or has_function_privilege(
       'service_role',
       'public.set_product_role_by_email(uuid,text,public.product_role,text)', 'EXECUTE')
    or not has_function_privilege(
       'authenticated',
       'public.list_admin_operators_page(integer,text,timestamp with time zone,uuid)', 'EXECUTE') then
    raise exception 'operator role grants are wrong';
  end if;

  for v_role in select unnest(array['public', 'anon', 'authenticated', 'service_role'])
  loop
    if has_function_privilege(
        v_role, 'private.apply_product_role_change(uuid,uuid,public.product_role,text,uuid)',
        'EXECUTE')
      or has_function_privilege(
        v_role,
        'private.list_admin_operators_page_provider_internal(integer,text,timestamp with time zone,uuid)',
        'EXECUTE') then
      raise exception 'private operator helper is callable by %', v_role;
    end if;
  end loop;

  -- The retired matrix stays retired.
  if has_function_privilege(
      'authenticated',
      'public.manage_user_role_confirmed(uuid,public.app_role,text,uuid,text,text,text)', 'EXECUTE')
    or has_function_privilege(
      'service_role',
      'public.set_user_capabilities_confirmed(uuid,text[],text,uuid,text,text,text)', 'EXECUTE') then
    raise exception 'legacy role or capability RPC came back';
  end if;

  v_definition := pg_get_functiondef(
    'private.apply_product_role_change(uuid,uuid,public.product_role,text,uuid)'::regprocedure
  );
  if position('CANNOT_CHANGE_OWN_ROLE' in v_definition) = 0
    or position('LAST_ACTIVE_ADMIN_PROTECTED' in v_definition) = 0
    or position('SUPERADMIN_DEMOTION_FORBIDDEN' in v_definition) = 0
    or position('AUTH_REALM_INVALID' in v_definition) = 0
    or position('safetyhub.skip_role_audit' in v_definition) = 0
    or position('''role.changed''' in v_definition) = 0
    -- Writing only product_role would let a later legacy write restore access.
    or position('product_role = p_role' in v_definition) = 0 then
    raise exception 'product role contract is incomplete';
  end if;

  select role.user_id into v_admin
  from public.user_roles role
  join public.account_controls control on control.user_id = role.user_id
  where role.product_role = 'admin' and control.status = 'active'
  order by role.user_id
  limit 1;
  select auth_user.id, auth_user.email::text into v_target, v_email
  from auth.users auth_user
  join public.user_roles role on role.user_id = auth_user.id
  join public.account_controls control on control.user_id = auth_user.id
  where role.product_role = 'participant'
    and control.status = 'active'
    and auth_user.email is not null
    and auth_user.email::text not like '%@auth.invalid'
  order by auth_user.id
  limit 1;
  if v_admin is null or v_target is null then
    raise notice 'product role behaviour skipped: workspace seed absent';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  begin
    perform public.set_product_role_by_user_id(
      gen_random_uuid(), v_admin, 'participant', 'Попытка снять права с себя'
    );
    raise exception 'self demotion was accepted';
  exception when insufficient_privilege then
    null;
  end;

  -- An unknown address with the admin role is parked as a pending grant since
  -- 20260905170000; the refusal contract remains for the participant role.
  begin
    perform public.set_product_role_by_email(
      gen_random_uuid(), 'nobody@example.com', 'participant', 'Неизвестный адрес почты'
    );
    raise exception 'an unknown address was accepted';
  exception when no_data_found then
    null;
  end;

  begin
    perform public.set_product_role_by_email(gen_random_uuid(), v_email, 'admin', 'коротко');
    raise exception 'a short reason was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  -- A messy address still resolves; both role columns move together.
  perform public.set_product_role_by_email(
    v_key, '  ' || upper(v_email) || ' ', 'admin', 'Новый специалист по охране труда'
  );
  if not exists (
    select 1 from public.user_roles
    where user_id = v_target and product_role = 'admin' and role = 'admin'
  ) then
    raise exception 'promotion did not move both role columns';
  end if;
  if (select count(*) from public.admin_audit_log
      where target_user_id = v_target and action = 'role.changed') <> 1
    or exists (
      select 1 from public.admin_audit_log
      where target_user_id = v_target and action = 'role.changed_directly'
    ) then
    raise exception 'promotion audit trail is wrong';
  end if;

  -- An unrelated legacy write must not resurrect the previous access level.
  update public.user_roles set role = role where user_id = v_target;
  if not exists (
    select 1 from public.user_roles where user_id = v_target and product_role = 'admin'
  ) then
    raise exception 'the legacy sync trigger reverted the product role';
  end if;

  if (public.set_product_role_by_email(
        v_key, '  ' || upper(v_email) || ' ', 'admin', 'Новый специалист по охране труда'
      ) ->> 'replayed') <> 'true' then
    raise exception 'replaying the same key did not return the stored receipt';
  end if;

  perform public.set_product_role_by_user_id(
    gen_random_uuid(), v_target, 'participant', 'Сотрудник больше не ведёт аттестации'
  );
  if not exists (
    select 1 from public.user_roles
    where user_id = v_target and product_role = 'participant' and role = 'user'
  ) then
    raise exception 'demotion did not move both role columns';
  end if;
end;
$test$;

rollback;
