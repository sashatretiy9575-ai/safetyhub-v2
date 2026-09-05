begin;

do $test$
declare
  v_admin uuid;
  v_target uuid;
  v_second uuid;
  v_definition text;
  v_result jsonb;
  v_key uuid := gen_random_uuid();
begin
  -- Grants: the operator purge is a browser operation, its single-target body is not.
  if not has_function_privilege(
       'authenticated', 'public.admin_purge_user_accounts(uuid,uuid[],text)', 'EXECUTE')
    or has_function_privilege(
       'anon', 'public.admin_purge_user_accounts(uuid,uuid[],text)', 'EXECUTE')
    or has_function_privilege(
       'service_role', 'public.admin_purge_user_accounts(uuid,uuid[],text)', 'EXECUTE') then
    raise exception 'immediate purge grants are wrong';
  end if;
  for v_definition in
    select unnest(array['public', 'anon', 'authenticated', 'service_role'])
  loop
    if has_function_privilege(
      v_definition,
      'private.purge_user_account_immediate(uuid,uuid,text,uuid)',
      'EXECUTE'
    ) then
      raise exception 'private purge body is callable by %', v_definition;
    end if;
  end loop;

  -- The staged path stays exactly as it was for self-service deletion.
  if has_function_privilege('authenticated', 'public.begin_user_account_purge(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.purge_user_account(uuid)', 'EXECUTE') then
    raise exception 'staged purge leaked to the browser role';
  end if;

  v_definition := pg_get_functiondef(
    'public.admin_purge_user_accounts(uuid,uuid[],text)'::regprocedure
  );
  if position('private.require_capability(''user.delete'')' in v_definition) = 0
    or position('private.lock_auth_admin_outbox()' in v_definition) = 0
    or position('private.lock_active_superadmin_invariant()' in v_definition) = 0
    or position('private.lock_signup_legal_operations()' in v_definition) = 0
    or position('private.enforce_actor_quota(''admin.purge'')' in v_definition) = 0
    or position('CANNOT_DELETE_SELF' in v_definition) = 0
    or position('LAST_ACTIVE_ADMIN_PROTECTED' in v_definition) = 0
    or position('IDEMPOTENCY_KEY_REUSED' in v_definition) = 0
    or position('admin_operation_receipts' in v_definition) = 0
    or position('sanitize_bulk_mutation_result' in v_definition) = 0 then
    raise exception 'immediate purge contract is incomplete';
  end if;

  v_definition := pg_get_functiondef(
    'private.purge_user_account_immediate(uuid,uuid,text,uuid)'::regprocedure
  );
  if position('has_pending_auth_admin_operation' in v_definition) = 0
    or position('initial_course_import_operations' in v_definition) = 0
    or position('''storage_cleared''' in v_definition) = 0
    or position('''post_purge_cleanup''' in v_definition) = 0
    or position('safetyhub.storage_purge_user_id' in v_definition) = 0
    or position('safetyhub.purge_operation_ids' in v_definition) = 0
    or position('''user.purged''' in v_definition) = 0 then
    raise exception 'single-target purge body is incomplete';
  end if;

  -- Quota tariff for the bulk call, alongside the untouched per-account one.
  if (select quota from private.quota_policy('admin.purge')) is null
    or (select window_seconds from private.quota_policy('admin.purge')) <> 300
    or (select quota from private.quota_policy('admin.delete')) <> 10 then
    raise exception 'purge quota tariff is wrong';
  end if;

  select role.user_id into v_admin
  from public.user_roles role
  join public.account_controls control on control.user_id = role.user_id
  where role.product_role = 'admin' and control.status = 'active'
  order by role.user_id
  limit 1;
  select role.user_id into v_target
  from public.user_roles role
  join public.account_controls control on control.user_id = role.user_id
  where role.product_role = 'participant' and control.status = 'active'
  order by role.user_id
  limit 1;
  select role.user_id into v_second
  from public.user_roles role
  join public.account_controls control on control.user_id = role.user_id
  where role.product_role = 'participant' and control.status = 'active'
    and role.user_id <> v_target
  order by role.user_id
  limit 1;
  if v_admin is null or v_target is null or v_second is null then
    raise notice 'immediate purge behaviour skipped: workspace seed absent';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  begin
    perform public.admin_purge_user_accounts(
      gen_random_uuid(), array[v_admin], 'Попытка удалить собственный аккаунт'
    );
    raise exception 'self deletion was accepted';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.admin_purge_user_accounts(
      gen_random_uuid(), array[v_target], 'коротко'
    );
    raise exception 'a short reason was accepted';
  exception when invalid_parameter_value then
    null;
  end;

  v_result := public.admin_purge_user_accounts(
    v_key, array[v_target], 'Проверка немедленного удаления администратором'
  );
  if v_result -> 'items' -> 0 ->> 'status' <> 'completed' then
    raise exception 'immediate purge did not complete: %', v_result;
  end if;
  if exists (select 1 from auth.users where id = v_target)
    or exists (select 1 from public.profiles where id = v_target)
    or exists (select 1 from public.attestations where user_id = v_target) then
    raise exception 'account survived the immediate purge';
  end if;
  if not exists (
    select 1 from private.account_storage_cleanup_tombstones
    where user_id = v_target and state = 'post_purge_cleanup' and auth_purged_at is not null
  ) then
    raise exception 'storage tombstone was not left for the reconciler';
  end if;
  -- The audit trail must survive the deletion it describes, without the target
  -- foreign key and without the deleted person's data.
  if not exists (
    select 1 from public.admin_audit_log
    where action = 'user.purged' and target_id = v_target::text and target_user_id is null
  ) then
    raise exception 'deletion left no audit trail';
  end if;
  -- The batch summary row is filtered out by the audit whitelist
  -- (20260905140000): per-account user.purged rows are the only record.
  if exists (
    select 1 from public.admin_audit_log where action = 'user.purge.bulk'
  ) then
    raise exception 'bulk purge still writes a duplicate summary row';
  end if;

  if (public.admin_purge_user_accounts(
        v_key, array[v_target], 'Проверка немедленного удаления администратором'
      ) ->> 'replayed') <> 'true' then
    raise exception 'replaying the same key did not return the stored receipt';
  end if;

  begin
    perform public.admin_purge_user_accounts(
      v_key, array[v_second], 'Проверка немедленного удаления администратором'
    );
    raise exception 'a reused key with different targets was accepted';
  exception when integrity_constraint_violation then
    null;
  end;
end;
$test$;

rollback;
