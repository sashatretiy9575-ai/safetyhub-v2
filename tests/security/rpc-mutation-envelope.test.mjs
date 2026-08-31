import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('reserved mutation envelopes are validated and converted into server errors', async () => {
  const source = await read('lib/supabase/rpc-mutation-result.ts');
  assert.match(source, /__safetyhubRpcError/);
  assert.match(source, /payload\?\.version !== 1/);
  assert.match(source, /SQLSTATE_PATTERN\.test\(code\)/);
  assert.match(source, /MESSAGE_PATTERN\.test\(message\)/);
  assert.match(source, /throw error/);
  assert.match(source, /unwrapRpcMutationResponse/);
  assert.match(source, /code === '54000'/);
  assert.match(source, /message === 'ATTEMPT_ROLLING_LIMIT'/);
  assert.match(source, /message === 'ATTEMPT_DAILY_LIMIT'/);
  assert.match(source, /Object\.keys\(detail\)\.length !== 1/);
  assert.match(source, /JSON\.stringify\(\{ retryAt:/);
  assert.doesNotMatch(source, /hint\s*:\s*payload/);
});

test('every metered application RPC unwraps the reserved error envelope before success', async () => {
  const files = [
    'features/site-settings/server.ts',
    'lib/actions/articles.ts',
    'features/identity/server.ts',
    'features/learning/server.ts',
    'features/admin/attestations.ts',
    'features/admin/certificates.ts',
    'features/admin/server.ts',
    'app/api/profile/route.ts',
    'app/api/profile/onboarding/route.ts',
    'app/api/profile/legal-acceptances/route.ts',
    'app/api/admin/attestations/export/route.ts',
  ];
  for (const file of files) {
    const source = await read(file);
    assert.match(
      source,
      /(?:unwrapRpcMutationResponse|getRpcMutationError)/,
      `${file} must reject a database mutation error envelope`,
    );
  }
});

test('API error mapping preserves safe SQLSTATE classes without leaking database detail', async () => {
  const source = await read('features/auth/api-error.ts');
  assert.match(source, /error instanceof RpcMutationError/);
  assert.match(source, /error\.code === '42501'/);
  assert.match(source, /'23505', '55000', '40001', '40P01'/);
  assert.match(source, /'23502', '23503', '23514', '23P01'/);
});
