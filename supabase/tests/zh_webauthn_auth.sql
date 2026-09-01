begin;

do $test$
declare
  v_user_id uuid := '7a000000-0000-4000-8000-000000000001';
  v_admin_id uuid := '7a000000-0000-4000-8000-000000000002';
  v_request_id uuid := '7a000000-0000-4000-8000-000000000003';
  v_reset_id uuid := '7a000000-0000-4000-8000-000000000004';
  v_session_id uuid := '7a000000-0000-4000-8000-000000000005';
  v_handle text := repeat('A', 43);
  v_credential text := repeat('B', 43);
  v_result jsonb;
  v_failed boolean;
  v_definition text;
  v_item jsonb;
begin
  if to_regclass('private.zh_webauthn_credentials') is null
    or to_regclass('private.zh_webauthn_challenges') is null
    or to_regclass('private.zh_recovery_codes') is null
    or to_regclass('private.zh_session_grants') is null
    or to_regclass('private.zh_authorized_sessions') is null
    or to_regclass('private.zh_registration_operations') is null then
    raise exception 'zh WebAuthn private schema is incomplete';
  end if;

  if has_table_privilege('anon', 'private.zh_webauthn_credentials', 'select')
    or has_table_privilege('authenticated', 'private.zh_webauthn_credentials', 'select')
    or has_table_privilege('service_role', 'private.zh_webauthn_credentials', 'select')
    or has_table_privilege('anon', 'private.zh_recovery_codes', 'select')
    or has_table_privilege('authenticated', 'private.zh_recovery_codes', 'select')
    or has_table_privilege('service_role', 'private.zh_recovery_codes', 'select')
    or has_table_privilege('authenticated', 'private.zh_authorized_sessions', 'select')
    or has_table_privilege('service_role', 'private.zh_authorized_sessions', 'select') then
    raise exception 'private zh credential or recovery state leaked table access';
  end if;

  if has_function_privilege(
    'anon', 'public.prepare_zh_authentication_challenge(uuid,text)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.prepare_zh_authentication_challenge(uuid,text)', 'EXECUTE'
  ) or not has_function_privilege(
    'service_role', 'public.prepare_zh_authentication_challenge(uuid,text)', 'EXECUTE'
  ) then
    raise exception 'zh authentication challenge RPC grants are unsafe';
  end if;

  if has_function_privilege(
    'anon', 'public.reset_zh_credential(uuid,text,uuid,uuid,text,text)', 'EXECUTE'
  ) or not has_function_privilege(
    'authenticated', 'public.reset_zh_credential(uuid,text,uuid,uuid,text,text)', 'EXECUTE'
  ) then
    raise exception 'zh admin reset RPC grant contract is incorrect';
  end if;

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
      jsonb_build_object('safetyhub_auth_kind', 'zh_passkey'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_admin_id,
      'authenticated', 'authenticated', 'zh-test-admin@example.com', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  update public.user_roles set role = 'superadmin' where user_id = v_admin_id;
  update public.profiles
  set name = '测试', surname = '用户', job = '工人', organization = '测试组织',
      phone_country_iso2 = 'KZ', phone_e164 = '+77000000000',
      preferred_locale = 'zh',
      onboarding_completed_at = statement_timestamp()
  where id = v_user_id;
  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = statement_timestamp(),
      approval_due_at = statement_timestamp() + interval '24 hours'
  where user_id = v_user_id;

  insert into private.zh_webauthn_accounts (user_id, user_handle)
  values (v_user_id, v_handle);
  insert into private.zh_webauthn_credentials (
    credential_id, user_id, public_key, signature_counter,
    transports, device_type, backed_up
  ) values (
    v_credential, v_user_id, decode(repeat('11', 32), 'hex'), 4,
    array['internal'], 'multiDevice', true
  );
  insert into private.zh_recovery_codes (
    locator, user_id, salt, digest, kind
  ) values (
    '7a000000-0000-4000-8000-000000000099', v_user_id,
    repeat('2', 32), repeat('3', 64), 'self_recovery'
  );

  -- A synthetic magic-link token without a server grant is rejected, while a
  -- one-use grant adds the epoch claim and cannot be replayed.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'magiclink',
    'claims', jsonb_build_object('sub', v_user_id)
  ));
  if v_result -> 'error' ->> 'message' <> 'PASSKEY_REQUIRED' then
    raise exception 'synthetic magiclink was accepted without a session grant: %', v_result;
  end if;

  insert into private.zh_session_grants (user_id, auth_epoch)
  values (v_user_id, 1);
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'magiclink',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_id,
      'email', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid',
      'phone', '',
      'email_verified', true
    )
  ));
  if v_result -> 'claims' ->> 'safetyhub_auth_kind' <> 'zh_passkey'
    or (v_result -> 'claims' ->> 'safetyhub_zh_epoch')::bigint <> 1
    or v_result -> 'claims' ->> 'email' <> ''
    or v_result -> 'claims' ->> 'phone' <> ''
    or v_result -> 'claims' ? 'email_verified'
    or v_result::text like '%@auth.invalid%' then
    raise exception 'synthetic session grant did not stamp/redact claims: %', v_result;
  end if;
  if not exists (
    select 1 from private.zh_authorized_sessions
    where session_id = v_session_id and user_id = v_user_id and auth_epoch = 1
  ) then
    raise exception 'magiclink grant did not bind the exact Auth session';
  end if;
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'magiclink',
    'claims', jsonb_build_object('sub', v_user_id)
  ));
  if v_result -> 'error' ->> 'message' <> 'PASSKEY_REQUIRED' then
    raise exception 'synthetic session grant was reusable: %', v_result;
  end if;

  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'token_refresh',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_id,
      'email', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid',
      'phone', ''
    )
  ));
  if v_result ? 'error'
    or v_result -> 'claims' ->> 'email' <> ''
    or v_result::text like '%@auth.invalid%' then
    raise exception 'current synthetic refresh epoch was rejected or leaked: %', v_result;
  end if;

  -- Authentication completion consumes the exact challenge and atomically
  -- updates the stored signature counter.
  insert into private.zh_webauthn_challenges (
    id, purpose, challenge_sha256, expires_at
  ) values (
    v_request_id, 'authentication', repeat('4', 64),
    statement_timestamp() + interval '5 minutes'
  );
  v_result := public.complete_zh_authentication(
    v_request_id, v_credential, 4, 5, true
  );
  if v_result ->> 'userId' <> v_user_id::text
    or (select signature_counter from private.zh_webauthn_credentials
        where credential_id = v_credential) <> 5
    or (select consumed_at from private.zh_webauthn_challenges
        where id = v_request_id) is null then
    raise exception 'zh assertion completion did not consume/update atomically: %', v_result;
  end if;
  v_failed := false;
  begin
    perform public.complete_zh_authentication(v_request_id, v_credential, 5, 6, true);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'ZH_AUTHENTICATION_FAILED' then v_failed := true; else raise; end if;
  end;
  if not v_failed then raise exception 'zh authentication challenge replay succeeded'; end if;

  insert into private.zh_webauthn_challenges (
    id, purpose, challenge_sha256, expires_at
  ) values (
    '7a000000-0000-4000-8000-000000000006', 'authentication', repeat('7', 64),
    statement_timestamp() + interval '5 minutes'
  );
  v_failed := false;
  begin
    perform public.complete_zh_authentication(
      '7a000000-0000-4000-8000-000000000006', v_credential, 5, 5, true
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'ZH_AUTHENTICATION_FAILED' then v_failed := true; else raise; end if;
  end;
  if not v_failed then
    raise exception 'non-monotonic nonzero WebAuthn counter was accepted';
  end if;

  -- Learner and administrator projections redact the provider-only email.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  select to_jsonb(context_row) into v_result
  from public.get_auth_context() context_row;
  if not (v_result ? 'email') or v_result -> 'email' <> 'null'::jsonb then
    raise exception 'synthetic email leaked from auth context: %', v_result;
  end if;
  if v_result ->> 'profile_preferred_locale' <> 'zh' then
    raise exception 'zh preferred locale missing from auth context: %', v_result;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_result := public.list_pending_account_approval_page(25, null, null);
  select item.value into v_item
  from jsonb_array_elements(v_result -> 'items') item(value)
  where item.value ->> 'id' = v_user_id::text;
  if v_item is null or v_item -> 'email' <> 'null'::jsonb then
    raise exception 'synthetic email leaked from approval queue: %', v_result;
  end if;

  v_result := private.redact_zh_email_items(jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object(
      'id', v_user_id,
      'email', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid',
      'label', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@auth.invalid'
    ))
  ));
  if v_result::text like '%@auth.invalid%' then
    raise exception 'synthetic email leaked through an administrator label: %', v_result;
  end if;

  update public.user_roles set role = 'admin' where user_id = v_user_id;
  v_result := public.list_admin_access_users_page(50, null, null, null);
  select item.value into v_item
  from jsonb_array_elements(v_result -> 'items') item(value)
  where item.value ->> 'id' = v_user_id::text;
  if v_item is null or v_item -> 'email' <> 'null'::jsonb then
    raise exception 'synthetic email leaked from admin-access directory: %', v_result;
  end if;

  -- Reset is reasoned/idempotent, revokes every passkey, rotates the epoch and
  -- leaves only a digest. Replaying the same request returns the same receipt.
  v_result := public.reset_zh_credential(
    v_user_id,
    'Verified owner requested passkey reset',
    v_reset_id,
    v_reset_id,
    repeat('5', 32),
    repeat('6', 64)
  );
  if v_result ->> 'userId' <> v_user_id::text
    or (v_result ->> 'replayed')::boolean
    or exists (
      select 1 from private.zh_webauthn_credentials
      where user_id = v_user_id and state = 'active'
    )
    or (select auth_epoch from private.zh_webauthn_accounts
        where user_id = v_user_id) <> 2
    or exists (
      select 1 from private.zh_recovery_codes
      where user_id = v_user_id and consumed_at is null
        and (salt <> repeat('5', 32) or digest <> repeat('6', 64))
    ) then
    raise exception 'zh reset contract failed: %', v_result;
  end if;
  v_result := public.reset_zh_credential(
    v_user_id,
    'Verified owner requested passkey reset',
    v_reset_id,
    v_reset_id,
    repeat('5', 32),
    repeat('6', 64)
  );
  if not (v_result ->> 'replayed')::boolean then
    raise exception 'zh reset idempotency receipt did not replay: %', v_result;
  end if;

  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'token_refresh',
    'claims', jsonb_build_object(
      'sub', v_user_id, 'session_id', v_session_id
    )
  ));
  if v_result -> 'error' ->> 'message' <> 'PASSKEY_REQUIRED' then
    raise exception 'pre-reset refresh epoch remained usable: %', v_result;
  end if;

  select lower(pg_get_functiondef(
    'public.enforce_email_otp_access_token(jsonb)'::regprocedure
  )) into v_definition;
  if position('consume_zh_session_grant' in v_definition) = 0
    or position('refresh_zh_authorized_session' in v_definition) = 0
    or position('safetyhub_zh_epoch' in v_definition) = 0 then
    raise exception 'token hook is not bound to one-use grant and auth epoch';
  end if;
end;
$test$;

rollback;
