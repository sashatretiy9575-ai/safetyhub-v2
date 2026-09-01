import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(path, 'utf8');

test('synthetic otp provider sessions consume the passkey grant without widening Auth access', async () => {
  const [migration, sqlContract, server] = await Promise.all([
    read('supabase/migrations/20260901109300_zh_otp_session_grant_provider_contract.sql'),
    read('supabase/tests/zh_session_provider_method.sql'),
    read('features/auth/zh-webauthn-server.ts'),
  ]);

  assert.match(migration, /v_authentication_method in \('magiclink', 'otp'\)/u);
  assert.match(migration, /private\.consume_zh_session_grant\(v_user_id, v_session_id\)/u);
  assert.match(migration, /elsif v_authentication_method = 'token_refresh'/u);
  assert.match(migration, /message', 'PASSKEY_REQUIRED'/u);
  assert.match(
    migration,
    /revoke all on function public\.enforce_email_otp_access_token\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.enforce_email_otp_access_token\(jsonb\)[\s\S]*?to supabase_auth_admin/u,
  );
  assert.match(
    server,
    /token_hash: generated\.data\.properties\.hashed_token,[\s\S]*?type: 'magiclink'/u,
  );
  assert.match(sqlContract, /synthetic otp was accepted without a passkey session grant/u);
  assert.match(sqlContract, /otp grant did not bind and consume the exact session/u);
  assert.match(sqlContract, /synthetic otp replay reused a consumed grant/u);
  assert.match(sqlContract, /'anon'::name, 'authenticated'::name, 'service_role'::name/u);
});
