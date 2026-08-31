-- SafetyHub exposes email OTP as its only user-facing authentication method.
--
-- Important provider constraint: native Supabase email OTP auto-registration
-- creates an opaque random password hash internally before the email code is
-- confirmed. A trigger that rejects non-empty auth.users.encrypted_password
-- would therefore reject legitimate first-time OTP registration. Do not use
-- auth.users.encrypted_password as a passwordless invariant.
--
-- Instead, block issuance of usable SafetyHub tokens for non-email-code
-- authentication methods. The hosted Auth hook is enabled declaratively in
-- supabase/config.toml only after this function has been migrated.

create or replace function public.enforce_email_otp_access_token(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_authentication_method text := lower(
    replace(coalesce(event ->> 'authentication_method', ''), '"', '')
  );
begin
  -- `email/signup` is the first verified code for a new account. Supabase
  -- may report an email code flow as `otp` or `magiclink` depending on the
  -- provider endpoint/template. `token_refresh` only extends a session that
  -- was already allowed by this hook.
  if v_authentication_method = any (
    array['email/signup', 'otp', 'magiclink', 'token_refresh']
  ) then
    return event;
  end if;

  -- The hook runs before a JWT is issued, so password/recovery/invite/OAuth
  -- and other unsupported provider methods cannot create a usable SafetyHub
  -- session even if an operator or raw Auth endpoint attempts the method.
  return jsonb_build_object(
    'error',
    jsonb_build_object(
      'http_code', 403,
      'message', 'EMAIL_OTP_REQUIRED'
    )
  );
end;
$$;

revoke all on function public.enforce_email_otp_access_token(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_email_otp_access_token(jsonb)
  to supabase_auth_admin;

comment on function public.enforce_email_otp_access_token(jsonb) is
  'Supabase Custom Access Token Hook for SafetyHub: permits only email-code session issuance and token refresh; rejects password, recovery, invite, OAuth, phone, and anonymous methods.';
