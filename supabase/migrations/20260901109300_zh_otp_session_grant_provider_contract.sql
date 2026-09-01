-- Supabase Auth v2.194 issues a POST /verify token_hash session with the
-- `otp` authentication method even when the verified token type is
-- `magiclink`. The browser still cannot authorize a synthetic identity:
-- either provider label must atomically consume the same two-minute grant
-- created only after a server-verified passkey/recovery ceremony.

create or replace function public.enforce_email_otp_access_token(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authentication_method text := lower(
    replace(coalesce(event ->> 'authentication_method', ''), '"', '')
  );
  v_user_id uuid;
  v_is_zh boolean := false;
  v_epoch bigint;
  v_session_id uuid;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
  begin
    v_user_id := coalesce(nullif(event ->> 'user_id', ''), v_claims ->> 'sub')::uuid;
  exception when others then
    v_user_id := null;
  end;
  begin
    v_session_id := nullif(v_claims ->> 'session_id', '')::uuid;
  exception when others then
    v_session_id := null;
  end;
  if v_user_id is not null then
    select exists (
      select 1 from private.zh_webauthn_accounts account
      where account.user_id = v_user_id
    ) into v_is_zh;
  end if;

  if v_is_zh then
    -- Keep required claims present while removing the private provider-only
    -- address and optional verification companions from browser JWTs.
    v_claims := (v_claims - 'email_verified' - 'phone_verified')
      || jsonb_build_object('email', '', 'phone', '');
    if v_authentication_method in ('magiclink', 'otp') then
      v_epoch := private.consume_zh_session_grant(v_user_id, v_session_id);
      if v_epoch is not null then
        event := jsonb_set(
          event,
          '{claims}',
          v_claims || jsonb_build_object(
            'safetyhub_auth_kind', 'zh_passkey',
            'safetyhub_zh_epoch', v_epoch
          ),
          true
        );
        return event;
      end if;
    elsif v_authentication_method = 'token_refresh' then
      v_epoch := private.refresh_zh_authorized_session(v_user_id, v_session_id);
      if v_epoch is not null then
        event := jsonb_set(
          event,
          '{claims}',
          v_claims || jsonb_build_object(
            'safetyhub_auth_kind', 'zh_passkey',
            'safetyhub_zh_epoch', v_epoch
          ),
          true
        );
        return event;
      end if;
    end if;
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'PASSKEY_REQUIRED')
    );
  end if;

  if v_authentication_method = any (
    array['email/signup', 'otp', 'magiclink', 'token_refresh']
  ) then
    return event;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object('http_code', 403, 'message', 'EMAIL_OTP_REQUIRED')
  );
end;
$$;

revoke all on function public.enforce_email_otp_access_token(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.enforce_email_otp_access_token(jsonb)
  to supabase_auth_admin;

comment on function public.enforce_email_otp_access_token(jsonb) is
  'Custom Access Token Hook. Synthetic ZH otp/magiclink issuance requires one atomic short-lived passkey session grant; refresh requires the exact authorized session epoch.';
