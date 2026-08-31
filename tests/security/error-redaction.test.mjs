import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('production client diagnostics omit exception messages and stacks', async () => {
  const source = await readFile(new URL('../../lib/observability.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.NODE_ENV !== 'production'/u);
  assert.match(source, /message: development \?/u);
  assert.match(source, /stack: development &&/u);
  assert.match(source, /development\s*\? payload\s*:/u);
});

test('profile data failures never log a raw upstream error object', async () => {
  const source = await readFile(new URL('../../features/profile/server.ts', import.meta.url), 'utf8');
  const functionBody = source.match(/function loadFailure[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.doesNotMatch(functionBody, /cause:\s*error[\s,}]/u);
  assert.match(functionBody, /UNKNOWN_PROFILE_DATA_ERROR/u);
});

test('admin diagnostics retain only bounded machine codes, never raw database messages', async () => {
  const [attestations, data, organizations, helper] = await Promise.all([
    read('features/admin/attestations.ts'),
    read('features/admin/data.ts'),
    read('features/admin/organizations.ts'),
    read('lib/security/error-diagnostics.ts'),
  ]);
  for (const source of [attestations, data, organizations]) {
    assert.match(source, /safeErrorDiagnosticCode/);
    assert.doesNotMatch(source, /String\(error\.message\)|error\.message\.slice/);
  }
  assert.match(helper, /SAFE_DIAGNOSTIC_CODE/);
  assert.match(helper, /return fallback/);
});
