import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

async function missing(file) {
  await assert.rejects(access(new URL(`../../${file}`, import.meta.url)));
}

const repositoryRoot = new URL('../../', import.meta.url);

async function sourceFiles(directory) {
  const entries = await readdir(new URL(`${directory}/`, repositoryRoot), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

test('application MFA routes, screens, recovery storage, and capability are absent', async () => {
  await Promise.all([
    missing('app/(account)/auth/mfa/page.tsx'),
    missing('app/api/auth/mfa/recover/route.ts'),
    missing('app/api/auth/mfa/recovery-codes/route.ts'),
    missing('app/api/admin/users/[userId]/mfa-reset/route.ts'),
    missing('features/auth/mfa-settings.tsx'),
    missing('features/auth/mfa-challenge.tsx'),
    missing('components/admin/mfa-reset-control.tsx'),
    missing('lib/security/mfa-policy.ts'),
  ]);

  const [baseline, auth, capabilities, adminLayout] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('features/auth/server.ts'),
    read('lib/security/capabilities.ts'),
    read('app/(admin)/admin/layout.tsx'),
  ]);
  assert.doesNotMatch(baseline, /mfa|aal2|totp|recovery_codes/i);
  assert.doesNotMatch(auth, /requiresMfa|mfaAssuranceLevel|requireFresh/);
  assert.doesNotMatch(capabilities, /mfa_reset|MFA/);
  assert.doesNotMatch(adminLayout, /\/auth\/mfa|requiresMfa|aal2/);
});

test('application source tree contains no MFA implementation symbols or routes', async () => {
  const files = (
    await Promise.all(['app', 'components', 'features', 'lib'].map((root) => sourceFiles(root)))
  ).flat();
  const forbiddenSymbol =
    /requiresMfa|mfaAssuranceLevel|requireFresh(?:Capability|Role)|privilegedStepUpMaxAgeSeconds|latestTotpVerification|isMfaVerificationFresh|mfa_reset|mfa_recovery_codes|aal2|totp/i;

  for (const file of files) {
    assert.doesNotMatch(await read(file), forbiddenSymbol, `stale MFA implementation in ${file}`);
    assert.doesNotMatch(file, /(?:^|\/)mfa(?:-|\/|\.)/i, `stale MFA path: ${file}`);
  }
});

test('password-only auth keeps role, capability, origin, quota, and audit controls', async () => {
  const [baseline, requestOrigin, adminServer] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('features/auth/request-origin.ts'),
    read('features/admin/server.ts'),
  ]);

  assert.match(baseline, /private\.require_capability/);
  assert.match(baseline, /create table public\.admin_audit_log/);
  assert.match(baseline, /create table private\.business_rate_limits/);
  assert.match(requestOrigin, /isSameOriginRequest/);
  assert.match(requestOrigin, /invalidOriginResponse/);
  assert.match(adminServer, /requireCapability\(/);
  assert.doesNotMatch(adminServer, /requireFreshCapability|requireFreshRole/);
});
