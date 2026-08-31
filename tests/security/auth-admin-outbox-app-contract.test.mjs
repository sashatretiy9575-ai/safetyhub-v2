import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('outbox claims stay bounded and historical password invites are terminally retired', async () => {
  const [source, types, data, apiError, retryRoute] = await Promise.all([
    read('features/admin/server.ts'),
    read('features/admin/types.ts'),
    read('features/admin/data.ts'),
    read('features/auth/api-error.ts'),
    read('app/api/admin/outbox/[operationId]/retry/route.ts'),
  ]);

  assert.match(source, /operationType: 'invite' \| 'suspend' \| 'restore';/u);
  assert.match(source, /value\.operationId !== operationId/u);
  assert.match(source, /OUTBOX_COMPLETION_TOKEN_PATTERN\.test\(value\.completionToken\)/u);
  assert.match(source, /UUID_PATTERN\.test\(value\.externalTargetId\)/u);
  assert.doesNotMatch(source, /operationType: [^;]*'delete'/u);
  assert.doesNotMatch(types, /operationType: [^;]*'delete'/u);
  assert.doesNotMatch(data, /z\.enum\(\[[^\]]*'delete'[^\]]*\]\)/u);

  // New accounts are created only through email OTP. The retired admin-invite
  // entry point must not retain a dormant path to Supabase password invites.
  assert.doesNotMatch(source, /export async function inviteUser\b/u);
  assert.doesNotMatch(
    source,
    /inviteUserByEmail|createPendingInviteContext|newPasswordContextToken|prepare_user_invite|auth\/invite/iu,
  );

  const reconciliation = source.slice(source.indexOf('export async function reconcileAuthAdminOperation'));
  assert.match(
    reconciliation,
    /if \(operation\.operationType === 'invite'\) \{[\s\S]*?advanceOutbox\(handle, 'failed', operation\.externalTargetId, retirement\);[\s\S]*?throw retirement;/u,
  );
  assert.doesNotMatch(
    reconciliation,
    /inviteUserByEmail|createPendingInviteContext|passwordTicket|auth\/invite|inviteUserMatches/iu,
  );
  assert.match(retryRoute, /await reconcileAuthAdminOperation\(/u);
  assert.match(apiError, /message\.includes\('PASSWORDLESS_INVITE_RETIRED'\)/u);
  assert.match(apiError, /\{ error: 'PASSWORDLESS_INVITE_RETIRED' \}, \{ status: 410 \}/u);
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
