import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recoveryVerifySchema } from '../../lib/validation/auth.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('recovery verification accepts one normalized email and exactly six ASCII digits', () => {
  assert.deepEqual(recoveryVerifySchema.parse({ email: ' User@Example.COM ', code: '123456' }), {
    email: 'user@example.com',
    code: '123456',
  });

  for (const code of ['12345', '1234567', '12 3456', 'abcdef', '１２３４５６', '١٢٣٤٥٦']) {
    assert.equal(
      recoveryVerifySchema.safeParse({ email: 'user@example.com', code }).success,
      false,
    );
  }
});

test('both recovery endpoints enforce origin and bounded JSON before Auth calls', async () => {
  const [start, verify] = await Promise.all([
    read('app/api/auth/password/recovery/route.ts'),
    read('app/api/auth/password/recovery/verify/route.ts'),
  ]);

  for (const source of [start, verify]) {
    assert.match(source, /isSameOriginRequest\(request\)/u);
    assert.match(source, /readJsonBody\(request\)/u);
    assert.match(source, /INVALID_REQUEST/u);
  }
  assert.match(start, /resetPasswordForEmail\(parsed\.data\.email/u);
  assert.doesNotMatch(start, /redirectTo|ConfirmationURL|password_ticket/u);
  assert.match(
    verify,
    /email: parsed\.data\.email,[\s\S]*token: parsed\.data\.code,[\s\S]*type: 'recovery'/u,
  );
  assert.match(verify, /RECOVERY_CODE_INVALID/u);
  assert.match(verify, /RATE_LIMITED/u);
  assert.match(verify, /RECOVERY_UNAVAILABLE/u);
});

test('browser persistence keeps only recovery email and phase, never code or password', async () => {
  const flow = await read('features/auth/password-recovery-flow.tsx');
  const storedAttempt = flow.slice(
    flow.indexOf('function storeAttempt'),
    flow.indexOf('function clearStoredAttempt'),
  );

  assert.match(storedAttempt, /JSON\.stringify\(\{ email, stage: 'code', sentAt \}/u);
  assert.doesNotMatch(storedAttempt, /\bcode\s*:|password|token/u);
  assert.match(flow, /autoComplete="one-time-code"/u);
  assert.match(flow, /inputMode="numeric"/u);
  assert.match(flow, /replace\(\/\\D\/gu, ''\)\.slice\(0, 6\)/u);
});
