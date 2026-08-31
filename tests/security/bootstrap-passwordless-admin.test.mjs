import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../../scripts/bootstrap-passwordless-admin.mjs', import.meta.url),
  'utf8',
);
const [migration, sqlContract, appTypes] = await Promise.all([
  readFile(
    new URL(
      '../../supabase/migrations/20260831119000_bootstrap_admin_legal_gate.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL('../../supabase/tests/bootstrap_passwordless_admin.sql', import.meta.url),
    'utf8',
  ),
  readFile(new URL('../../lib/supabase/types.ts', import.meta.url), 'utf8'),
]);

test('first-admin bootstrap is explicit, email-confirmed, legally accepted, and service-role-only', () => {
  assert.match(source, /option\('--email'\)/u);
  assert.match(source, /option\('--confirm-email'\)/u);
  assert.match(source, /BOOTSTRAP_ADMIN_CONFIRMATION_MISMATCH/u);
  assert.match(source, /BOOTSTRAP_ADMIN_REMOTE_CONFIRMATION_REQUIRED/u);
  assert.match(source, /SUPABASE_SECRET_KEY \?\? process\.env\.SUPABASE_SERVICE_ROLE_KEY/u);
  assert.match(source, /client\.auth\.admin\.listUsers/u);
  assert.match(source, /BOOTSTRAP_ADMIN_EMAIL_UNCONFIRMED/u);
  assert.match(source, /client\.rpc\('bootstrap_email_otp_admin', \{ p_user_id: user\.id \}\)/u);
  assert.match(source, /BOOTSTRAP_ADMIN_LEGAL_ACCEPTANCE_REQUIRED/u);
  assert.doesNotMatch(source, /client\.rpc\('restore_admin_access'/u);
  assert.match(source, /ADMIN_BOOTSTRAPPED/u);
  assert.doesNotMatch(source, /password|signInWithPassword|inviteUserByEmail|createUser/u);
});

test('first-admin bootstrap verifies all current legal documents inside a service-only DB operation', () => {
  assert.match(
    migration,
    /create function public\.bootstrap_email_otp_admin\(p_user_id uuid\)/u,
  );
  assert.match(migration, /lock table public\.legal_document_versions in share mode/u);
  assert.match(migration, /private\.has_current_legal_acceptance\(p_user_id\)/u);
  assert.match(migration, /message = 'LEGAL_ACCEPTANCE_REQUIRED'/u);
  assert.match(migration, /return public\.restore_admin_access\(p_user_id\)/u);
  assert.match(
    migration,
    /revoke execute on function public\.bootstrap_email_otp_admin\(uuid\)[\s\S]*?from public, anon, authenticated/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.bootstrap_email_otp_admin\(uuid\) to service_role/u,
  );
  assert.match(
    sqlContract,
    /stale legal acceptances received first-admin access/u,
  );
  assert.match(
    sqlContract,
    /public\.publish_legal_document_version\(/u,
  );
  assert.match(
    sqlContract,
    /v_bootstrapped_user_id := public\.bootstrap_email_otp_admin\(v_accepted_user_id\)/u,
  );
  assert.match(appTypes, /bootstrap_email_otp_admin: \{ Args: \{ p_user_id: string \}; Returns: string \}/u);
});
