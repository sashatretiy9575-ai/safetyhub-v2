begin;

do $contract$
declare
  v_user_id uuid := '7a000000-0000-4000-8000-000000000201';
  v_session_one uuid := '7a000000-0000-4000-8000-000000000202';
  v_session_two uuid := '7a000000-0000-4000-8000-000000000203';
  v_result jsonb;
  v_role name;
begin
  if position(
    'v_authentication_method in (''magiclink'', ''otp'')'
    in lower(pg_get_functiondef(
      'public.enforce_email_otp_access_token(jsonb)'::regprocedure
    ))
  ) = 0 then
    raise exception 'ZH hook does not accept the provider method emitted by token_hash verification';
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
    jsonb_build_object('safetyhub_auth_kind', 'zh_passkey'),
    jsonb_build_object('preferred_locale', 'zh'),
    statement_timestamp(),
    statement_timestamp()
  );
  insert into private.zh_webauthn_accounts (user_id, user_handle)
  values (v_user_id, repeat('C', 43));

  -- The provider's `otp` label alone is not authorization.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'otp',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_one,
      'email', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
      'phone', ''
    )
  ));
  if v_result -> 'error' ->> 'message' <> 'PASSKEY_REQUIRED' then
    raise exception 'synthetic otp was accepted without a passkey session grant: %', v_result;
  end if;

  insert into private.zh_session_grants (user_id, auth_epoch)
  values (v_user_id, 1);
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'otp',
    'claims', jsonb_build_object(
      'sub', v_user_id,
      'session_id', v_session_one,
      'email', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
      'phone', '',
      'email_verified', true
    )
  ));
  if v_result ? 'error'
    or v_result -> 'claims' ->> 'safetyhub_auth_kind' <> 'zh_passkey'
    or (v_result -> 'claims' ->> 'safetyhub_zh_epoch')::bigint <> 1
    or v_result -> 'claims' ->> 'email' <> ''
    or v_result -> 'claims' ? 'email_verified'
    or v_result::text like '%@auth.invalid%' then
    raise exception 'granted synthetic otp claims are invalid: %', v_result;
  end if;
  if not exists (
    select 1 from private.zh_authorized_sessions session_row
    where session_row.session_id = v_session_one
      and session_row.user_id = v_user_id
      and session_row.auth_epoch = 1
  ) or not exists (
    select 1 from private.zh_session_grants grant_row
    where grant_row.user_id = v_user_id
      and grant_row.consumed_at is not null
  ) then
    raise exception 'otp grant did not bind and consume the exact session';
  end if;

  -- The grant is one-use even if Auth retries with a different session UUID.
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'otp',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_two)
  ));
  if v_result -> 'error' ->> 'message' <> 'PASSKEY_REQUIRED' then
    raise exception 'synthetic otp replay reused a consumed grant: %', v_result;
  end if;

  -- Preserve the explicit magiclink label for compatible Auth flows; it is
  -- protected by the same atomic grant, not by the provider string.
  insert into private.zh_session_grants (user_id, auth_epoch)
  values (v_user_id, 1);
  v_result := public.enforce_email_otp_access_token(jsonb_build_object(
    'user_id', v_user_id,
    'authentication_method', 'magiclink',
    'claims', jsonb_build_object('sub', v_user_id, 'session_id', v_session_two)
  ));
  if v_result ? 'error'
    or v_result -> 'claims' ->> 'safetyhub_auth_kind' <> 'zh_passkey' then
    raise exception 'granted synthetic magiclink compatibility path failed: %', v_result;
  end if;
end;
$contract$;

rollback;
