begin;

-- 1. An account that authored the initial course import can be deleted: the
--    receipt keeps its row with the author nulled out.
do $test$
declare
  v_actor_id uuid := '76000000-0000-4000-8000-000000000001';
  v_admin_keeper uuid := '76000000-0000-4000-8000-000000000002';
  v_target_id uuid := '76000000-0000-4000-8000-000000000003';
  v_operation_id uuid;
  v_result jsonb;
  v_definition text;
begin
  if to_regclass('private.initial_course_import_operations') is null then
    raise notice 'purge receipt regression: import table absent; skipping';
    return;
  end if;
  v_definition := lower(pg_get_functiondef(
    'private.purge_user_account_immediate(uuid,uuid,text,uuid)'::regprocedure
  ));
  if position('account_has_import_receipt' in v_definition) > 0 then
    raise exception 'purge still refuses the author of an import receipt';
  end if;
  if not exists (
    select 1
    from information_schema.referential_constraints rc
    join information_schema.table_constraints tc
      on tc.constraint_name = rc.constraint_name and tc.constraint_schema = rc.constraint_schema
    where tc.table_schema = 'private'
      and tc.table_name = 'initial_course_import_operations'
      and rc.constraint_name = 'initial_course_import_operations_created_by_fkey'
      and rc.delete_rule = 'SET NULL'
  ) then
    raise exception 'import receipt author reference must null out on delete';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_actor_id,
      'authenticated', 'authenticated', 'purge-receipt-actor@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_admin_keeper,
      'authenticated', 'authenticated', 'purge-receipt-keeper@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_target_id,
      'authenticated', 'authenticated', 'purge-receipt-target@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );
  update public.user_roles set role = 'admin' where user_id in (v_actor_id, v_admin_keeper);

  insert into private.initial_course_import_operations (
    project_ref, catalog_hash, status, created_by, pre_receipt
  ) values (
    'abcdefghijklmnopqrst',
    repeat('a', 64),
    'begun',
    v_target_id,
    '{}'::jsonb
  ) returning id into v_operation_id;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_actor_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_actor_id)::text,
    true
  );

  v_result := public.admin_purge_user_accounts(
    '77000000-0000-4000-8000-000000000001',
    array[v_target_id],
    'Test: the author of an import receipt is deleted'
  );
  if (v_result -> 'items' -> 0 ->> 'status') is distinct from 'completed' then
    raise exception 'purge of the import author did not complete: %', v_result;
  end if;
  if exists (select 1 from auth.users where id = v_target_id) then
    raise exception 'import author survived the purge';
  end if;
  if not exists (
    select 1 from private.initial_course_import_operations
    where id = v_operation_id and created_by is null
  ) then
    raise exception 'import receipt did not keep its row with the author nulled';
  end if;
end;
$test$;

-- 2. One row of certificate settings, read by the server and by administrators
--    with the site-settings capability, written with a version check.
do $test$
declare
  v_admin_id uuid := '76000000-0000-4000-8000-000000000011';
  v_learner_id uuid := '76000000-0000-4000-8000-000000000012';
  v_settings jsonb;
  v_updated jsonb;
  v_blocked boolean := false;
begin
  if to_regclass('public.certificate_settings') is null
    or to_regprocedure('public.get_certificate_settings(boolean)') is null
    or to_regprocedure('public.update_certificate_settings(jsonb,bigint)') is null then
    raise exception 'certificate settings contract missing';
  end if;
  if has_table_privilege('authenticated', 'public.certificate_settings', 'select')
    or has_table_privilege('anon', 'public.certificate_settings', 'select')
    or has_function_privilege('anon', 'public.update_certificate_settings(jsonb,bigint)', 'EXECUTE') then
    raise exception 'certificate settings grant boundary invalid';
  end if;
  if (select count(*) from public.certificate_settings) <> 1 then
    raise exception 'certificate settings must be one seeded row';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_admin_id,
      'authenticated', 'authenticated', 'certificate-settings-admin@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_learner_id,
      'authenticated', 'authenticated', 'certificate-settings-learner@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );
  update public.user_roles set role = 'admin' where user_id = v_admin_id;

  -- A learner reads nothing.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_learner_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_learner_id)::text,
    true
  );
  begin
    perform public.get_certificate_settings(false);
    raise exception 'a learner read the certificate settings';
  exception when others then
    v_blocked := sqlerrm <> 'a learner read the certificate settings';
  end;
  if not v_blocked then
    raise exception 'learner read was not refused';
  end if;

  -- The administrator reads flags rather than image bytes, and updates
  -- against the version it read.
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_admin_id)::text,
    true
  );
  v_settings := public.get_certificate_settings(true);
  if v_settings ->> 'stampPng' is not null and jsonb_typeof(v_settings -> 'stampPng') <> 'null' then
    raise exception 'an administrator session received image bytes: %', v_settings -> 'hasStamp';
  end if;
  if (v_settings ->> 'organizationName') is distinct from 'SafetyHub' then
    raise exception 'default organization must be plain SafetyHub: %', v_settings ->> 'organizationName';
  end if;
  if position('{protocol}' in (v_settings ->> 'examTextRu')) = 0 then
    raise exception 'default exam text must carry the protocol placeholder';
  end if;

  v_updated := public.update_certificate_settings(
    jsonb_build_object(
      'chairmanName', '  Иванов И. И.  ',
      'chairmanPosition', 'Директор',
      'protocolNumber', '09/04',
      'validityMonths', 24,
      'stampPng', 'data:image/png;base64,iVBORw0KGgo='
    ),
    (v_settings ->> 'version')::bigint
  );
  if (v_updated ->> 'chairmanName') is distinct from 'Иванов И. И.'
    or (v_updated ->> 'chairmanPosition') is distinct from 'Директор'
    or (v_updated ->> 'protocolNumber') is distinct from '09/04'
    or (v_updated ->> 'validityMonths')::integer <> 24
    or (v_updated ->> 'hasStamp')::boolean is not true
    or (v_updated ->> 'version')::bigint <> (v_settings ->> 'version')::bigint + 1 then
    raise exception 'certificate settings update did not apply: %', v_updated;
  end if;

  -- A stale version is refused, an absent key leaves the value alone, and
  -- a null image key clears the image.
  v_updated := public.update_certificate_settings(
    jsonb_build_object('bin', '123'),
    (v_settings ->> 'version')::bigint
  );
  if (v_updated ->> 'error') is distinct from 'CERTIFICATE_SETTINGS_VERSION_CONFLICT'
    and (v_updated #>> '{__safetyhubRpcError,message}') is distinct from 'CERTIFICATE_SETTINGS_VERSION_CONFLICT' then
    raise exception 'stale version was accepted: %', v_updated;
  end if;
  v_updated := public.update_certificate_settings(
    jsonb_build_object('stampPng', null),
    (v_settings ->> 'version')::bigint + 1
  );
  if (v_updated ->> 'hasStamp')::boolean is not false
    or (v_updated ->> 'chairmanName') is distinct from 'Иванов И. И.' then
    raise exception 'clearing the stamp changed more than the stamp: %', v_updated;
  end if;

  -- The server role receives the bytes it needs for the image route.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  v_settings := public.get_certificate_settings(true);
  if (v_settings ->> 'protocolNumber') is distinct from '09/04' then
    raise exception 'service role did not read the saved settings: %', v_settings;
  end if;
end;
$test$;

rollback;
