begin;

do $contract$
declare
  v_user_id uuid := '7a000000-0000-4000-8000-000000000201';
  v_session_one uuid := '7a000000-0000-4000-8000-000000000202';
  v_result jsonb;
  v_role name;
  v_failed boolean := false;
begin
  if to_regclass('private.zh_username_accounts') is null
    or to_regclass('private.zh_username_authorized_sessions') is null then
    raise exception 'ZH username/password private schema is incomplete';
  end if;

  foreach v_role in array array['anon'::name, 'authenticated'::name, 'service_role'::name]
  loop
    if has_function_privilege(
      v_role,
      'public.enforce_email_otp_access_token(jsonb)',
      'execute'
    ) then
      raise exception '% can execute the Auth hook directly', v_role;
    end if;
  end loop;
  if not has_function_privilege(
    'supabase_auth_admin',
    'public.enforce_email_otp_access_token(jsonb)',
    'execute'
  ) then
    raise exception 'supabase_auth_admin cannot execute the Auth hook';
  end if;
  if has_function_privilege(
    'anon', 'public.get_zh_username_password_rollout_enabled()', 'execute'
  ) or has_function_privilege(
    'authenticated', 'public.get_zh_username_password_rollout_enabled()', 'execute'
  ) or not has_function_privilege(
    'service_role', 'public.get_zh_username_password_rollout_enabled()', 'execute'
  ) then
    raise exception 'ZH rollout read grants are unsafe';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
    '',
    statement_timestamp(),
    jsonb_build_object('safetyhub_auth_kind', 'zh_username_password'),
    jsonb_build_object('preferred_locale', 'zh'),
    statement_timestamp(),
    statement_timestamp()
  );
  insert into private.zh_username_accounts (user_id, username, synthetic_email)
  values (v_user_id, 'zhcontract201', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid');

  -- The database gate is false after migration.  Even a valid password
  -- provider event must not authorize a session before an operator receipt.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'password',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_one,
      'email', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
      'phone', ''
    )
  ));
  if v_result -> 'error' ->> 'message' <> 'ZH_USERNAME_PASSWORD_REQUIRED' then
    raise exception 'database rollout-off password authentication was accepted: %', v_result;
  end if;

  -- The new feature name is accepted without weakening the independent
  -- Telegram application-details dependency inherited from the prior migration.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true
  );
  v_result := public.set_runtime_feature_flag(
    'zh_username_password',
    true,
    'Enable Chinese username password contract test',
    '7a000000-0000-4000-8000-000000000204'
  );
  if v_result ->> 'featureName' <> 'zh_username_password'
    or v_result ->> 'enabled' <> 'true'
    or public.get_zh_username_password_rollout_enabled() is not true then
    raise exception 'ZH runtime feature receipt was not enabled: %', v_result;
  end if;
  begin
    perform public.set_runtime_feature_flag(
      'telegram_application_details',
      true,
      'Must remain blocked without Telegram dependencies',
      '7a000000-0000-4000-8000-000000000205'
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'TELEGRAM_DELIVERY_MUST_BE_ENABLED_FIRST' then
      v_failed := true;
    else
      raise;
    end if;
  end;
  if not v_failed then
    raise exception 'ZH feature replacement weakened Telegram dependencies';
  end if;

  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'password',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_one,
      'email', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
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
      select 1 from private.zh_username_authorized_sessions session_row
      where session_row.session_id = v_session_one and session_row.user_id = v_user_id
    ) then
    raise exception 'exact password session was not bound and redacted: %', v_result;
  end if;

  -- ZH never accepts an email code, magic link, social provider, or any other
  -- non-password Auth provider string after the mapping exists.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'otp',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_one)
  ));
  if v_result -> 'error' ->> 'message' <> 'ZH_USERNAME_PASSWORD_REQUIRED' then
    raise exception 'ZH otp was accepted despite username-password-only policy: %', v_result;
  end if;
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'magiclink',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_one)
  ));
  if v_result -> 'error' ->> 'message' <> 'ZH_USERNAME_PASSWORD_REQUIRED' then
    raise exception 'ZH magiclink was accepted despite username-password-only policy: %', v_result;
  end if;

  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'token_refresh',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_one)
  ));
  if v_result ? 'error'
    or v_result -> 'claims' ->> 'safetyhub_auth_kind' <> 'zh_username_password' then
    raise exception 'bound password session refresh was rejected: %', v_result;
  end if;

  delete from private.zh_username_authorized_sessions
  where session_id = v_session_one;
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'token_refresh',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_one)
  ));
  if v_result -> 'error' ->> 'message' <> 'ZH_USERNAME_PASSWORD_REQUIRED' then
    raise exception 'deleted password session refreshed successfully: %', v_result;
  end if;

  -- Ordinary RU/KK/EN email-code issuance is unchanged by the ZH branch.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', '7a000000-0000-4000-8000-000000000206',
    'authentication_method', 'otp',
    'claims', jsonb_build_object('sub', '7a000000-0000-4000-8000-000000000206')
  ));
  if v_result ? 'error' then
    raise exception 'ordinary email OTP was unexpectedly rejected: %', v_result;
  end if;
end;
$contract$;

rollback;
