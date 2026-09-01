import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(path, 'utf8');

test('ZH password sessions are exact, rollout-gated, and never widen email OTP access', async () => {
  const [migration, sqlContract, server] = await Promise.all([
    read('supabase/migrations/20260902130000_zh_username_password_auth.sql'),
    read('supabase/tests/zh_session_provider_method.sql'),
    read('features/auth/zh-username-password-server.ts'),
  ]);

  assert.match(migration, /private\.runtime_feature_enabled\('zh_username_password'\)/u);
  assert.match(migration, /v_authentication_method = 'password'/u);
  assert.match(
    migration,
    /private\.authorize_zh_username_password_session\(v_user_id, v_session_id\)/u,
  );
  assert.match(migration, /elsif v_authentication_method = 'token_refresh'/u);
  assert.match(
    migration,
    /private\.refresh_zh_username_password_session\(v_user_id, v_session_id\)/u,
  );
  assert.match(migration, /message', 'ZH_USERNAME_PASSWORD_REQUIRED'/u);
  assert.match(migration, /message', 'ZH_AUTH_METHOD_RETIRED'/u);
  assert.match(
    migration,
    /private\.zh_webauthn_accounts legacy_account[\s\S]*return false/u,
  );
  assert.match(
    migration,
    /revoke all on function public\.enforce_email_otp_access_token\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.enforce_email_otp_access_token\(jsonb\)[\s\S]*?to supabase_auth_admin/u,
  );
  assert.match(server, /get_zh_username_password_rollout_enabled/u);
  assert.match(sqlContract, /database rollout-off password authentication was accepted/u);
  assert.match(sqlContract, /exact password session was not bound and redacted/u);
  assert.match(sqlContract, /ZH otp was accepted despite username-password-only policy/u);
  assert.match(sqlContract, /deleted password session refreshed successfully/u);
  assert.match(sqlContract, /'anon'::name, 'authenticated'::name, 'service_role'::name/u);
});
