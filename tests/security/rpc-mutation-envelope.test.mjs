import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('education refusal retains its exact SQLSTATE without accepting arbitrary field details', async () => {
  const source = (await read('server/supabase/rpc-mutation-result.ts'))
    .replace("import 'server-only';", '')
    .replace(
      /import \{ normalizeRateLimitError \} from '[^']+';/,
      'const normalizeRateLimitError = (error: unknown) => { throw error; };',
    );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const { getRpcMutationError, unwrapRpcMutationResponse } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  );
  const envelope = (code, message, extra = {}) => ({
    __safetyhubRpcError: { version: 1, code, message, ...extra },
  });
  const education = envelope('22023', 'DOCUMENT_REQUIRED_FIELDS:education');
  const error = getRpcMutationError(education);
  assert.equal(error.code, '22023');
  assert.equal(error.message, 'DOCUMENT_REQUIRED_FIELDS:education');
  assert.equal(error.details, null);
  assert.throws(() => unwrapRpcMutationResponse({ data: education, error: null }), {
    code: '22023',
    message: 'DOCUMENT_REQUIRED_FIELDS:education',
  });
  for (const value of [
    envelope('42501', 'DOCUMENT_REQUIRED_FIELDS:education'),
    envelope('22023', 'DOCUMENT_REQUIRED_FIELDS:education,email'),
    envelope('22023', 'DOCUMENT_REQUIRED_FIELDS:education\nprivate data'),
    envelope('22023', 'private database detail'),
    envelope('22023', 'DOCUMENT_REQUIRED_FIELDS:education', { details: { education: 'private' } }),
  ]) {
    assert.equal(getRpcMutationError(value).message, 'RPC_MUTATION_FAILED');
  }
  const limited = getRpcMutationError(
    envelope('54000', 'ATTEMPT_DAILY_LIMIT', {
      details: { retryAt: '2026-09-20T00:00:00Z' },
    }),
  );
  assert.equal(limited.code, '54000');
  assert.equal(limited.message, 'ATTEMPT_DAILY_LIMIT');
  assert.deepEqual(JSON.parse(limited.details), { retryAt: '2026-09-20T00:00:00.000Z' });
  assert.equal(
    getRpcMutationError(envelope('54000', 'RATE_LIMITED:60')).message,
    'RATE_LIMITED:60',
  );
});

test('reserved mutation envelopes are validated and converted into server errors', async () => {
  const source = await read('server/supabase/rpc-mutation-result.ts');
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
    'server/site-settings.ts',
    'server/actions/articles.ts',
    'server/identity/verification.ts',
    'server/learning/attempts.ts',
    'server/admin/attestations.ts',
    'server/admin/management.ts',
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
  const source = await read('server/auth/api-error.ts');
  assert.match(source, /error instanceof RpcMutationError/);
  assert.match(source, /error\.code === '42501'/);
  assert.match(source, /'23505', '55000', '40001', '40P01'/);
  assert.match(source, /'23502', '23503', '23514', '23P01'/);
});
