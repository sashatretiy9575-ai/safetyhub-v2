import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../../scripts/bootstrap-passwordless-admin.mjs', import.meta.url),
  'utf8',
);

test('first-admin bootstrap is explicit, email-confirmed, and service-role-only', () => {
  assert.match(source, /option\('--email'\)/u);
  assert.match(source, /option\('--confirm-email'\)/u);
  assert.match(source, /BOOTSTRAP_ADMIN_CONFIRMATION_MISMATCH/u);
  assert.match(source, /BOOTSTRAP_ADMIN_REMOTE_CONFIRMATION_REQUIRED/u);
  assert.match(source, /SUPABASE_SECRET_KEY \?\? process\.env\.SUPABASE_SERVICE_ROLE_KEY/u);
  assert.match(source, /client\.auth\.admin\.listUsers/u);
  assert.match(source, /BOOTSTRAP_ADMIN_EMAIL_UNCONFIRMED/u);
  assert.match(source, /client\.rpc\('restore_admin_access', \{ p_user_id: user\.id \}\)/u);
  assert.match(source, /ADMIN_BOOTSTRAPPED/u);
  assert.doesNotMatch(source, /password|signInWithPassword|inviteUserByEmail|createUser/u);
});
