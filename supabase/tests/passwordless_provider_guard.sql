begin;

do $test$
declare
  v_result jsonb;
  v_method text;
begin
  if not exists (
    select 1
    from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'enforce_email_otp_access_token'
      and pg_get_function_identity_arguments(proc.oid) = 'event jsonb'
  ) then
    raise exception 'email OTP Custom Access Token Hook is missing';
  end if;

  if has_function_privilege(
    'anon', 'public.enforce_email_otp_access_token(jsonb)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.enforce_email_otp_access_token(jsonb)', 'EXECUTE'
  ) or has_function_privilege(
    'service_role', 'public.enforce_email_otp_access_token(jsonb)', 'EXECUTE'
  ) then
    raise exception 'email OTP token hook leaked direct execute';
  end if;

  if not has_function_privilege(
    'supabase_auth_admin', 'public.enforce_email_otp_access_token(jsonb)', 'EXECUTE'
  ) then
    raise exception 'Supabase Auth cannot execute the email OTP token hook';
  end if;

  if not has_schema_privilege('supabase_auth_admin', 'public', 'USAGE') then
    raise exception 'Supabase Auth cannot resolve the email OTP token hook schema';
  end if;

  foreach v_method in array array['email/signup', 'otp', 'magiclink', 'token_refresh'] loop
    select public.enforce_email_otp_access_token(
      jsonb_build_object(
        'authentication_method', v_method,
        'claims', jsonb_build_object('sub', '2e6b0000-0000-4000-8000-000000000001')
      )
    ) into v_result;

    if v_result ? 'error' then
      raise exception 'allowed email-code method % was rejected: %', v_method, v_result;
    end if;
  end loop;

  foreach v_method in array array['password', 'recovery', 'invite', 'oauth', 'anonymous', 'totp'] loop
    select public.enforce_email_otp_access_token(
      jsonb_build_object(
        'authentication_method', v_method,
        'claims', jsonb_build_object('sub', '2e6b0000-0000-4000-8000-000000000002')
      )
    ) into v_result;

    if v_result -> 'error' ->> 'http_code' <> '403'
      or v_result -> 'error' ->> 'message' <> 'EMAIL_OTP_REQUIRED' then
      raise exception 'unsupported method % was not rejected safely: %', v_method, v_result;
    end if;
  end loop;
end;
$test$;

rollback;
