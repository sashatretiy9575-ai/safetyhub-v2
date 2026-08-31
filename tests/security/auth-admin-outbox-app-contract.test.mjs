import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('invite reconciliation binds only a claimed target with exact email and correlation', async () => {
  const [source, types, data] = await Promise.all([
    read('features/admin/server.ts'),
    read('features/admin/types.ts'),
    read('features/admin/data.ts'),
  ]);

  assert.match(source, /operationType: 'invite' \| 'suspend' \| 'restore';/u);
  assert.match(source, /value\.operationId !== operationId/u);
  assert.match(source, /OUTBOX_COMPLETION_TOKEN_PATTERN\.test\(value\.completionToken\)/u);
  assert.match(source, /UUID_PATTERN\.test\(value\.externalTargetId\)/u);
  assert.doesNotMatch(source, /operationType: [^;]*'delete'/u);
  assert.doesNotMatch(types, /operationType: [^;]*'delete'/u);
  assert.doesNotMatch(data, /z\.enum\(\[[^\]]*'delete'[^\]]*\]\)/u);
  assert.doesNotMatch(source, /listUsers|users.*find|find.*email/iu);
  assert.match(source, /normalizeEmail\(user\.email\) === normalizeEmail\(email\)/u);
  assert.match(source, /user\.user_metadata\?\.safetyhubInviteCorrelation === inviteCorrelation/u);
  assert.match(source, /throw new Error\('OUTBOX_INVITE_TARGET_MISMATCH'\)/u);

  const targetlessBranch = source.match(
    /if \(!resolvedUserId\) \{[\s\S]*?resolvedUserId = invite\.data\.user\.id;\s*\}/u,
  )?.[0];
  assert.ok(targetlessBranch, 'targetless invite branch must remain explicit');
  assert.equal(
    targetlessBranch.match(/inviteUserByEmail\(/gu)?.length,
    1,
    'a targetless claimed operation must issue one invite attempt',
  );
});

test('outbox transitions persist a bounded category instead of an upstream message', async () => {
  const source = await read('features/admin/server.ts');
  const advance = source.match(/async function advanceOutbox[\s\S]*?\n\}/u)?.[0] ?? '';

  assert.match(source, /type OutboxErrorCategory =/u);
  assert.match(advance, /p_error: error \? outboxErrorCategory\(error\) : null/u);
  assert.doesNotMatch(advance, /externalErrorMessage\(error\)/u);
});

test('purge and storage-cleanup state conflicts return a safe 409', async () => {
  const source = await read('features/auth/api-error.ts');
  for (const token of [
    'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS',
    'ACCOUNT_STORAGE_CLEANUP_PENDING',
    'ACCOUNT_STORAGE_CLEANUP_IN_PROGRESS',
    'ACCOUNT_PURGE_NOT_READY',
  ]) {
    assert.match(source, new RegExp(`message\\.includes\\('${token}'\\)`));
  }
  assert.match(source, /\{ error: 'CONFLICT' \}, \{ status: 409 \}/u);
});
