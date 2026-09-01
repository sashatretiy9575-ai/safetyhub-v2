begin;

-- Historical filename retained so the established database test harness keeps
-- exercising the Chinese auth boundary.  The assertions below cover the
-- forward username/password cutover; WebAuthn routes themselves are tombstoned.
do $test$
declare
  v_user_id uuid := '7a000000-0000-4000-8000-000000000001';
  v_admin_id uuid := '7a000000-0000-4000-8000-000000000002';
  v_legacy_id uuid := '7a000000-0000-4000-8000-000000000003';
  v_retired_id uuid := '7a000000-0000-4000-8000-000000000004';
  v_session_id uuid := '7a000000-0000-4000-8000-000000000005';
  v_session_after_reset uuid := '7a000000-0000-4000-8000-000000000006';
  v_legacy_session uuid := '7a000000-0000-4000-8000-000000000007';
  v_result jsonb;
  v_item jsonb;
begin
  if to_regclass('private.zh_username_accounts') is null
    or to_regclass('private.zh_username_authorized_sessions') is null then
    raise exception 'ZH username/password private schema is incomplete';
  end if;
  if has_table_privilege('anon', 'private.zh_username_accounts', 'select')
    or has_table_privilege('authenticated', 'private.zh_username_accounts', 'select')
    or has_table_privilege('service_role', 'private.zh_username_accounts', 'select')
    or has_table_privilege('anon', 'private.zh_username_authorized_sessions', 'select')
    or has_table_privilege('authenticated', 'private.zh_username_authorized_sessions', 'select')
    or has_table_privilege('service_role', 'private.zh_username_authorized_sessions', 'select') then
    raise exception 'private ZH username mapping or session state leaked table access';
  end if;
  if has_function_privilege(
    'authenticated', 'private.zh_session_epoch_is_current(uuid)', 'execute'
  ) or not has_function_privilege(
    'postgres', 'private.zh_session_epoch_is_current(uuid)', 'execute'
  ) then
    raise exception 'ZH session guard grants are unsafe';
  end if;
  if has_function_privilege(
    'anon', 'public.begin_zh_username_password_reset(uuid,text)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.begin_zh_username_password_reset(uuid,text)', 'execute'
  ) or has_function_privilege(
    'service_role', 'public.begin_zh_username_password_reset(uuid,text)', 'execute'
  ) then
    raise exception 'ZH administrator recovery RPC grant contract is incorrect';
  end if;

  update private.runtime_feature_flags
  set enabled = true
  where feature_name = 'zh_username_password';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_user_id,
      'authenticated', 'authenticated',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid', '',
      statement_timestamp(),
      jsonb_build_object('safetyhub_auth_kind', 'zh_username_password'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_admin_id,
      'authenticated', 'authenticated', 'zh-test-admin@example.com', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_legacy_id,
      'authenticated', 'authenticated',
      'cccccccccccccccccccccccccccccccc@auth.invalid', '',
      statement_timestamp(),
      jsonb_build_object('safetyhub_auth_kind', 'zh_passkey'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_retired_id,
      'authenticated', 'authenticated',
      'dddddddddddddddddddddddddddddddd@auth.invalid', '',
      statement_timestamp(),
      jsonb_build_object('safetyhub_auth_kind', 'zh_passkey'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    );
  update public.user_roles set role = 'superadmin' where user_id = v_admin_id;
  update public.profiles
  set name = '测试', surname = '用户', job = '工人', organization = '测试组织',
      phone_country_iso2 = 'KZ', phone_e164 = '+77000000000',
      preferred_locale = 'zh', onboarding_completed_at = statement_timestamp()
  where id = v_user_id;
  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = statement_timestamp(),
      approval_due_at = statement_timestamp() + interval '24 hours'
  where user_id = v_user_id;

  insert into private.zh_username_accounts (user_id, username, synthetic_email)
  values (v_user_id, 'zhcontract001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid');
  insert into private.zh_webauthn_accounts (user_id, user_handle)
  values
    (v_legacy_id, repeat('C', 43)),
    (v_retired_id, repeat('D', 43));

  -- Password issuance creates an exact server-side session mapping and removes
  -- the opaque provider identifier from the browser claims.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'password',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_id,
      'email', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid',
      'phone', '',
      'email_verified', true
    )
  ));
  if v_result ? 'error'
    or v_result -> 'claims' ->> 'safetyhub_auth_kind' <> 'zh_username_password'
    or v_result -> 'claims' ->> 'email' <> ''
    or v_result -> 'claims' ->> 'phone' <> ''
    or v_result -> 'claims' ? 'email_verified'
    or v_result::text like '%@auth.invalid%'
    or not exists (
      select 1 from private.zh_username_authorized_sessions
      where session_id = v_session_id and user_id = v_user_id
    ) then
    raise exception 'ZH password session did not bind/redact safely: %', v_result;
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_user_id,
    'session_id', v_session_id,
    'safetyhub_auth_kind', 'zh_username_password'
  )::text, true);
  select to_jsonb(context_row) into v_result
  from public.get_auth_context() context_row;
  if not (v_result ? 'email') or v_result -> 'email' <> 'null'::jsonb
    or v_result ->> 'profile_preferred_locale' <> 'zh' then
    raise exception 'ZH username auth context leaked provider identity: %', v_result;
  end if;

  -- Administrator-mediated reset disables the mapping and revokes all exact
  -- sessions before the server asks GoTrue to change a password.  This SQL
  -- contract models the safe DB halves around that transient provider call.
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_admin_id
  )::text, true);
  v_result := public.begin_zh_username_password_reset(
    v_user_id, 'Verified owner requested administrator recovery'
  );
  if v_result ->> 'state' <> 'username_password_pending'
    or not (select password_change_pending from private.zh_username_accounts
            where user_id = v_user_id)
    or exists (
      select 1 from private.zh_username_authorized_sessions where user_id = v_user_id
    ) then
    raise exception 'ZH password reset did not fail closed before provider update: %', v_result;
  end if;
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'password',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_after_reset)
  ));
  if v_result -> 'error' ->> 'message' <> 'ZH_USERNAME_PASSWORD_REQUIRED' then
    raise exception 'pending password recovery allowed a new session: %', v_result;
  end if;
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_user_id,
    'session_id', v_session_id,
    'safetyhub_auth_kind', 'zh_username_password'
  )::text, true);
  select to_jsonb(context_row) into v_result
  from public.get_auth_context() context_row;
  if v_result is not null then
    raise exception 'pre-recovery ZH access token remained usable: %', v_result;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_admin_id
  )::text, true);
  v_result := public.complete_zh_username_password_reset(
    v_user_id, 'Administrator completed verified password replacement'
  );
  if v_result ->> 'state' <> 'username_password'
    or (select password_change_pending from private.zh_username_accounts
        where user_id = v_user_id) then
    raise exception 'ZH password recovery did not finalize safely: %', v_result;
  end if;

  -- Legacy WebAuthn is explicitly rejected.  An administrator can instead
  -- transition it into the same disabled mapping, then complete recovery.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_retired_id,
    'authentication_method', 'otp',
    'claims', jsonb_build_object('sub', v_retired_id, 'session_id', v_legacy_session)
  ));
  if v_result -> 'error' ->> 'message' <> 'ZH_AUTH_METHOD_RETIRED' then
    raise exception 'legacy ZH WebAuthn provider was not retired: %', v_result;
  end if;
  insert into private.zh_authorized_sessions (session_id, user_id, auth_epoch)
  values (v_legacy_session, v_retired_id, 1);
  perform set_config('request.jwt.claim.sub', v_retired_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_retired_id,
    'session_id', v_legacy_session,
    'safetyhub_auth_kind', 'zh_passkey', 'safetyhub_zh_epoch', 1
  )::text, true);
  select to_jsonb(context_row) into v_result
  from public.get_auth_context() context_row;
  if v_result is not null then
    raise exception 'already-issued legacy passkey JWT retained a grace period: %', v_result;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_admin_id
  )::text, true);
  v_result := public.provision_zh_username_password(
    v_legacy_id,
    'legacycutover003',
    'Verified owner approved legacy credential transition'
  );
  if v_result ->> 'state' <> 'username_password_pending'
    or not exists (
      select 1 from private.zh_username_accounts
      where user_id = v_legacy_id and password_change_pending
    )
    or exists (
      select 1 from private.zh_webauthn_accounts where user_id = v_legacy_id
    )
    or (select raw_app_meta_data ->> 'safetyhub_auth_kind' from auth.users
        where id = v_legacy_id) <> 'zh_username_password' then
    raise exception 'legacy ZH transition did not become fail-closed username mapping: %', v_result;
  end if;
  v_result := public.complete_zh_username_password_reset(
    v_legacy_id,
    'Administrator completed legacy password replacement'
  );
  if v_result ->> 'state' <> 'username_password'
    or (select password_change_pending from private.zh_username_accounts
        where user_id = v_legacy_id) then
    raise exception 'legacy ZH transition did not finalize: %', v_result;
  end if;

  -- Existing administrator directories inherit the synthetic-identity
  -- redaction helper, so the provider-only address remains unrecoverable.
  v_result := public.list_pending_account_approval_page(25, null, null);
  select item.value into v_item
  from jsonb_array_elements(v_result -> 'items') item(value)
  where item.value ->> 'id' = v_user_id::text;
  if v_item is null or v_item -> 'email' <> 'null'::jsonb then
    raise exception 'synthetic email leaked from approval queue: %', v_result;
  end if;
end;
$test$;

rollback;
