begin;

-- Self-service account deletion completes inside one transaction: the auth
-- user, its profile and controls are gone, the audit row names the event, and
-- a pending deletion left by the old staged path is finished by email.
do $test$
declare
  v_owner uuid := gen_random_uuid();
  v_stale uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_result jsonb;
  v_actor text;
  v_purged jsonb;
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_owner,
      'authenticated', 'authenticated', 'self-purge-owner@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_stale,
      'authenticated', 'authenticated', 'Self-Purge-Stale@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_admin,
      'authenticated', 'authenticated', 'self-purge-admin@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  -- 1. The owner's purge removes the account in one call.
  v_result := public.self_purge_user_account(v_owner);
  if v_result ->> 'status' <> 'completed' then
    raise exception 'owner purge did not complete: %', v_result;
  end if;
  if exists (select 1 from auth.users where id = v_owner)
    or exists (select 1 from public.profiles where id = v_owner)
    or exists (select 1 from public.account_controls where user_id = v_owner) then
    raise exception 'owner rows survived the purge';
  end if;
  select actor_user_id::text into v_actor
  from public.admin_audit_log
  where action = 'user.self_purged' and target_id = v_owner::text;
  if not found then
    raise exception 'self purge was not audited';
  end if;
  if v_actor is not null then
    raise exception 'self purge must carry no actor';
  end if;
  if exists (
    select 1 from private.account_storage_cleanup_tombstones
    where user_id = v_owner and state <> 'post_purge_cleanup'
  ) then
    raise exception 'tombstone must wait for the storage sweep';
  end if;

  -- 2. A second call for the same id is a no-op, not an error.
  v_result := public.self_purge_user_account(v_owner);
  if v_result ->> 'status' <> 'skipped' or v_result ->> 'reason' <> 'ALREADY_ABSENT' then
    raise exception 'repeated purge must be skipped: %', v_result;
  end if;

  -- 3. An account the staged path left pending is finished by email, with the
  -- address matched case-insensitively; an ordinary account is left alone.
  update public.account_controls set deletion_pending = true where user_id = v_stale;
  v_purged := public.purge_pending_self_deletion('  self-purge-stale@SAFETYHUB.invalid ');
  if (v_purged ->> 'purged')::boolean is distinct from true
    or v_purged ->> 'status' <> 'completed' then
    raise exception 'pending self-deletion was not finished: %', v_purged;
  end if;
  if exists (select 1 from auth.users where id = v_stale) then
    raise exception 'stale auth user survived the sweep';
  end if;
  v_purged := public.purge_pending_self_deletion('self-purge-admin@safetyhub.invalid');
  if (v_purged ->> 'purged')::boolean is distinct from false
    or not exists (select 1 from auth.users where id = v_admin) then
    raise exception 'an account not marked for deletion must not be touched: %', v_purged;
  end if;
  v_purged := public.purge_pending_self_deletion('');
  if (v_purged ->> 'purged')::boolean is distinct from false then
    raise exception 'an empty email must not purge anything';
  end if;

  -- 4. The last active administrator cannot delete themselves.
  update public.account_controls
  set status = 'suspended'
  where user_id in (
    select role.user_id from public.user_roles role
    where role.product_role = 'admin' and role.user_id <> v_admin
  );
  update public.user_roles
  set role = 'admin', product_role = 'admin'
  where user_id = v_admin;
  begin
    perform public.self_purge_user_account(v_admin);
    raise exception 'the last active admin was deleted';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'LAST_ACTIVE_ADMIN_PROTECTED' then
        raise exception 'unexpected refusal: %', sqlerrm;
      end if;
  end;
  if not exists (select 1 from auth.users where id = v_admin) then
    raise exception 'refused purge must leave the admin in place';
  end if;

  -- 5. The functions are service-role only.
  if has_function_privilege('anon', 'public.self_purge_user_account(uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.self_purge_user_account(uuid)', 'execute')
    or has_function_privilege('anon', 'public.purge_pending_self_deletion(text)', 'execute')
    or has_function_privilege('authenticated', 'public.purge_pending_self_deletion(text)', 'execute')
    or not has_function_privilege('service_role', 'public.self_purge_user_account(uuid)', 'execute')
    or not has_function_privilege('service_role', 'public.purge_pending_self_deletion(text)', 'execute') then
    raise exception 'self purge grants drifted';
  end if;
end;
$test$;

rollback;
