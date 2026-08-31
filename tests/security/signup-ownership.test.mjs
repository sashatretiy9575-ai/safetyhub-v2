import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('signup legal ownership is prepared with a server-only hashed nonce', async () => {
  const helper = await read('features/auth/signup-legal.ts');

  assert.match(helper, /import 'server-only'/);
  assert.match(helper, /randomUUID\(\)/);
  assert.match(helper, /randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(helper, /createHash\('sha256'\)\.update\(signupNonce, 'utf8'\)\.digest\('hex'\)/);
  assert.match(helper, /rpc\('prepare_signup_legal_operation', \{/);
  for (const argument of [
    'p_operation_id',
    'p_nonce_sha256',
    'p_email',
    'p_privacy_version',
    'p_privacy_body_revision',
    'p_terms_version',
    'p_terms_body_revision',
  ]) {
    assert.match(helper, new RegExp(`\\b${argument}:`));
  }
  assert.doesNotMatch(helper, /console\.(?:log|error|warn|info|debug)/);
});

test('registration correlates only the prepared operation and stays enumeration-neutral', async () => {
  const route = await read('app/api/auth/register/route.ts');
  const prepareAt = route.indexOf('prepareSignupLegalOperation(');
  const signupAt = route.indexOf('.auth.signUp(');

  assert.ok(prepareAt >= 0 && signupAt > prepareAt, 'prepare must occur before Auth signup');
  assert.match(
    route,
    /data:\s*\{\s*safetyhubSignupOperationId: operation\.operationId,\s*safetyhubSignupNonce: operation\.signupNonce,?\s*\}/s,
  );
  assert.match(route, /finalizeSignupLegalOperation\(operation, data\.user\.id\)/);
  assert.match(route, /return NextResponse\.json\(\{ ok: true \}, \{ status: 201 \}\)/);
  assert.doesNotMatch(route, /\.identities\b|deleteUser\(|mark_signup_legal_acceptance/);
  assert.doesNotMatch(route, /legalAcceptance|SIGNUP_REJECTED/);
});

test('registration consumes a coarse network quota before durable preparation', async () => {
  const [route, rateLimit, migration] = await Promise.all([
    read('app/api/auth/register/route.ts'),
    read('lib/security/rate-limit.ts'),
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
  ]);
  const quotaAt = route.search(/consumeCoarseQuota\(\s*'auth\.register'/);
  const prepareAt = route.indexOf('prepareSignupLegalOperation(');
  const signupAt = route.indexOf('.auth.signUp(');

  assert.match(route, /requestSecurityMetadata\(request\)\.ipHash/);
  assert.ok(quotaAt >= 0, 'registration coarse quota is missing');
  assert.ok(quotaAt < prepareAt, 'registration quota must precede durable preparation');
  assert.ok(prepareAt < signupAt, 'durable preparation must still precede Auth signup');
  assert.match(rateLimit, /(?:\||^)\s*'auth\.register'/m);
  assert.match(migration, /when 'auth\.register' then 10/);
  assert.match(
    migration,
    /when p_action in \([\s\S]*'auth\.register'[\s\S]*\) then 3600/,
  );
});

test('finalize uses the exact idempotent ownership RPC contract', async () => {
  const helper = await read('features/auth/signup-legal.ts');

  assert.match(helper, /rpc\('finalize_signup_legal_operation', \{/);
  assert.match(helper, /p_operation_id: correlation\.operationId/);
  assert.match(helper, /p_user_id: userId/);
  assert.match(helper, /p_signup_nonce: correlation\.signupNonce/);
  assert.match(helper, /'completed' \| 'not_owned' \| 'expired'/);
  assert.match(helper, /accepted: boolean/);
});

test('confirmation retries metadata ownership proof and scrubs a completed session', async () => {
  const callback = await read('app/(account)/callback/route.ts');
  const recoveryAt = callback.indexOf('if (recoveryEvent)');
  const metadataAt = callback.indexOf('data.user.user_metadata');

  assert.ok(recoveryAt >= 0 && metadataAt > recoveryAt, 'recovery must bypass signup finalization');
  assert.match(callback, /signupLegalCorrelationFromUserMetadata\(\s*data\.user\.user_metadata/);
  assert.doesNotMatch(callback, /app_metadata/);
  assert.match(callback, /finalizeSignupLegalOperation\(signupCorrelation, data\.user\.id\)/);
  assert.match(callback, /finalized\.status === 'completed'/);
  assert.match(callback, /supabase\.auth\.refreshSession\(\)/);
  assert.match(callback, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.match(callback, /\/auth\/login\?error=confirmation/);
});

test('later login retries an incomplete signup proof without trusting the submitted email', async () => {
  const login = await read('app/api/auth/login/route.ts');

  assert.match(login, /signupLegalCorrelationFromUserMetadata\(data\.user\.user_metadata\)/);
  assert.match(login, /finalizeSignupLegalOperation\(signupCorrelation, data\.user\.id\)/);
  assert.match(login, /finalized\.status === 'completed'/);
  assert.match(login, /supabase\.auth\.refreshSession\(\)/);
  assert.match(login, /SIGNUP_FINALIZATION_UNAVAILABLE/);
  assert.doesNotMatch(
    login,
    /app_metadata|finalizeSignupLegalOperation\([^,]+,\s*parsed\.data\.email/,
  );
});

test('signup evidence is durable, nonce-hashed, and bound to the exact Auth identity', async () => {
  const migration = await read('supabase/migrations/20260813070000_persistent_actor_quota.sql');
  const table = migration.slice(
    migration.indexOf('create table private.signup_legal_operations'),
    migration.indexOf('create index signup_legal_operation_expiry_idx'),
  );
  const finalize = migration.slice(
    migration.indexOf('create function public.finalize_signup_legal_operation'),
    migration.indexOf('create function public.prune_signup_legal_operations'),
  );

  assert.match(table, /nonce_sha256 bytea not null check \(octet_length\(nonce_sha256\) = 32\)/);
  assert.match(table, /normalized_email text not null/);
  assert.match(table, /privacy_body_revision text not null/);
  assert.match(table, /terms_body_revision text not null/);
  assert.match(table, /expires_at <= prepared_at \+ interval '24 hours'/);
  assert.doesNotMatch(table, /signup_nonce/);

  assert.match(finalize, /extensions\.digest\(convert_to\(p_signup_nonce, 'utf8'\), 'sha256'\)/);
  assert.match(finalize, /from private\.signup_legal_operations operation[\s\S]*for update/);
  assert.match(finalize, /from auth\.users auth_user[\s\S]*for update/);
  assert.match(finalize, /from auth\.identities identity[\s\S]*for update/);
  assert.match(
    finalize,
    /lower\(btrim\(v_user\.email\)\) is distinct from v_operation\.normalized_email/,
  );
  assert.match(finalize, /v_user\.created_at < v_operation\.prepared_at/);
  assert.match(finalize, /v_user\.raw_user_meta_data ->> 'safetyhubSignupOperationId'/);
  assert.match(finalize, /v_identity\.user_id is distinct from p_user_id/);
  assert.match(finalize, /v_identity\.identity_data ->> 'sub'/);
  assert.match(finalize, /is distinct from p_user_id::text/);
  assert.match(finalize, /v_operation\.prepared_at, 'registration'/);
  assert.match(
    finalize,
    /update auth\.users[\s\S]*- 'safetyhubSignupOperationId' - 'safetyhubSignupNonce'/,
  );
  assert.match(
    finalize,
    /update auth\.identities[\s\S]*- 'safetyhubSignupOperationId' - 'safetyhubSignupNonce'/,
  );
  assert.doesNotMatch(finalize, /delete from auth\.users/);
});

test('signup preparation and finalization RPCs are service-only', async () => {
  const migration = await read('supabase/migrations/20260813070000_persistent_actor_quota.sql');

  for (const signature of [
    'public\\.prepare_signup_legal_operation\\(\\s*uuid,text,text,text,text,text,text\\s*\\)',
    'public\\.finalize_signup_legal_operation\\(uuid,uuid,text\\)',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke execute on function ${signature}\\s+from public, anon, authenticated, service_role;\\s*grant execute on function ${signature}\\s+to service_role`,
      ),
    );
  }
});
