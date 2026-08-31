/* eslint-disable */
// @ts-nocheck

import { createClient } from 'npm:@supabase/supabase-js@2.111.0';

const AVATAR_BUCKET = 'profile-avatars';
const COURSE_PRESENTATION_STAGING_BUCKET = 'course-presentations-staging';
const COURSE_PRESENTATION_PUBLIC_BUCKET = 'course-presentations';
const PAGE_SIZE = 100;
const MAX_OBJECTS_PER_PREFIX = 5_000;
const MAX_FOLDERS_PER_PREFIX = 128;
const MAX_LIST_REQUESTS_PER_PREFIX = 256;
const MAX_OBJECT_KEY_BYTES = 1_024;
const MAX_BEARER_BYTES = 512;
const EXAMPLE_RECONCILER_SECRET = 'replace-with-at-least-32-random-characters';
const MAX_AVATAR_OPERATIONS_PER_RUN = 50;
const MAX_ACCOUNT_TOMBSTONES_PER_RUN = 25;
const MAX_STALE_PRESENTATIONS_PER_RUN = 50;
const AVATAR_WORK_BUDGET_MS = 20_000;
const TOTAL_WORK_BUDGET_MS = 50_000;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const SHA256_SOURCE = '[0-9a-f]{64}';
const SHA256_PATTERN = new RegExp(`^${SHA256_SOURCE}$`);
const STAGING_PRESENTATION_PATH_PATTERN = new RegExp(
  `^(${UUID_SOURCE})/(${UUID_SOURCE})/source\\.pdf$`,
);
const PUBLIC_PRESENTATION_PATH_PATTERN = new RegExp(
  `^(${UUID_SOURCE})/(${UUID_SOURCE})/(${SHA256_SOURCE})\\.pdf$`,
);
const AVATAR_OBJECT_PATTERN = new RegExp(`^(${UUID_SOURCE})/objects/(${UUID_SOURCE})\\.webp$`);
const AVATAR_RECONCILE_STATES = new Set(['committed', 'reconcile_required', 'cancel_requested']);
const ACCOUNT_CLEANUP_CLAIM_STATES = new Set([
  'sweeping',
  'empty_once',
  'storage_cleared',
  'post_purge_cleanup',
  'post_purge_empty_once',
]);
const ACCOUNT_CLEANUP_ADVANCE_STATES = new Set([
  'cleanup_pending',
  'empty_once',
  'storage_cleared',
  'post_purge_cleanup',
  'post_purge_empty_once',
  'db_purged',
]);

class ReconcilerError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ReconcilerError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ReconcilerError(code);
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) fail(`MISSING_${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(record: Record<string, unknown>, key: string, errorCode: string) {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(errorCode);
  return value;
}

function parseUuid(value: unknown, errorCode: string) {
  if (typeof value !== 'string') fail(errorCode);
  const normalized = value.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) fail(errorCode);
  return normalized;
}

function parseAvatarObjectKey(
  value: unknown,
  expectedUserId: string,
  expectedOperationToken?: string,
) {
  if (typeof value !== 'string') fail('AVATAR_OBJECT_KEY_INVALID');
  const match = AVATAR_OBJECT_PATTERN.exec(value);
  if (
    !match ||
    match[1] !== expectedUserId ||
    (expectedOperationToken !== undefined && match[2] !== expectedOperationToken)
  ) {
    fail('AVATAR_OBJECT_KEY_INVALID');
  }
  return value;
}

function parsePublishedAvatarObjectKey(value: unknown, expectedUserId: string) {
  if (value === `${expectedUserId}/avatar.webp`) return value;
  return parseAvatarObjectKey(value, expectedUserId);
}

function parseAvatarClaim(value: unknown) {
  if (!isRecord(value)) fail('AVATAR_CLAIM_INVALID');
  const operationToken = parseUuid(value.operationToken, 'AVATAR_OPERATION_TOKEN_INVALID');
  const userId = parseUuid(value.userId, 'AVATAR_USER_ID_INVALID');
  const state = requiredText(value, 'state', 'AVATAR_STATE_INVALID');
  if (!AVATAR_RECONCILE_STATES.has(state)) fail('AVATAR_STATE_INVALID');
  const objectKey = parseAvatarObjectKey(value.objectKey, userId, operationToken);
  const previousObjectKey =
    value.previousObjectKey === null || value.previousObjectKey === undefined
      ? null
      : parsePublishedAvatarObjectKey(value.previousObjectKey, userId);
  if (previousObjectKey === objectKey) fail('AVATAR_PREVIOUS_OBJECT_INVALID');
  return { operationToken, userId, state, objectKey, previousObjectKey };
}

function parseManifestObjectKey(value: unknown, userId: string) {
  if (value === null) return null;
  if (!isRecord(value)) fail('AVATAR_MANIFEST_INVALID');
  return parsePublishedAvatarObjectKey(value.objectKey, userId);
}

function parseTombstoneClaim(value: unknown) {
  if (!isRecord(value)) fail('STORAGE_TOMBSTONE_INVALID');
  const tombstoneId = parseUuid(value.tombstoneId, 'STORAGE_TOMBSTONE_ID_INVALID');
  const userId = parseUuid(value.userId, 'STORAGE_USER_ID_INVALID');
  const state = requiredText(value, 'state', 'STORAGE_TOMBSTONE_STATE_INVALID');
  if (!ACCOUNT_CLEANUP_CLAIM_STATES.has(state)) fail('STORAGE_TOMBSTONE_STATE_INVALID');
  const storagePrefix = requiredText(value, 'storagePrefix', 'STORAGE_PREFIX_INVALID');
  if (storagePrefix !== `${userId}/`) fail('STORAGE_PREFIX_INVALID');
  return { tombstoneId, userId, state, storagePrefix };
}

function parseStorageObjectKey(value: unknown, errorCode: string) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    utf8Length(value) > MAX_OBJECT_KEY_BYTES
  ) {
    fail(errorCode);
  }
  return value;
}

function parseStalePresentationClaim(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    fail('PRESENTATION_CLEANUP_CLAIM_INVALID');
  }
  if (value.items.length > MAX_STALE_PRESENTATIONS_PER_RUN) {
    fail('PRESENTATION_CLEANUP_CLAIM_LIMIT');
  }
  return value.items.map((rawItem) => {
    if (!isRecord(rawItem)) fail('PRESENTATION_CLEANUP_ITEM_INVALID');
    const id = parseUuid(rawItem.id, 'PRESENTATION_CLEANUP_ID_INVALID');
    const bucket = rawItem.bucket;
    if (
      bucket !== COURSE_PRESENTATION_STAGING_BUCKET &&
      bucket !== COURSE_PRESENTATION_PUBLIC_BUCKET
    ) {
      fail('PRESENTATION_CLEANUP_BUCKET_INVALID');
    }
    const objectKey = parseStorageObjectKey(rawItem.path, 'PRESENTATION_CLEANUP_PATH_INVALID');
    const thumbnailPath =
      rawItem.thumbnailPath === null || rawItem.thumbnailPath === undefined
        ? null
        : parseStorageObjectKey(
            rawItem.thumbnailPath,
            'PRESENTATION_CLEANUP_THUMBNAIL_PATH_INVALID',
          );
    const sha256 = requiredText(rawItem, 'sha256', 'PRESENTATION_CLEANUP_SHA_INVALID');
    if (!SHA256_PATTERN.test(sha256)) fail('PRESENTATION_CLEANUP_SHA_INVALID');

    if (bucket === COURSE_PRESENTATION_STAGING_BUCKET) {
      const match = STAGING_PRESENTATION_PATH_PATTERN.exec(objectKey);
      if (!match) fail('PRESENTATION_CLEANUP_PATH_INVALID');
      if (thumbnailPath !== null && thumbnailPath !== `${match[1]}/${match[2]}/thumbnail.webp`) {
        fail('PRESENTATION_CLEANUP_THUMBNAIL_PATH_INVALID');
      }
    } else {
      const match = PUBLIC_PRESENTATION_PATH_PATTERN.exec(objectKey);
      if (!match || match[2] !== id || match[3] !== sha256) {
        fail('PRESENTATION_CLEANUP_PATH_INVALID');
      }
      if (thumbnailPath !== `${match[1]}/${match[2]}/${match[3]}-thumb.webp`) {
        fail('PRESENTATION_CLEANUP_THUMBNAIL_PATH_INVALID');
      }
    }
    return { id, bucket, objectKey, thumbnailPath };
  });
}

function claimArray(value: unknown, errorCode: string) {
  if (!Array.isArray(value) || value.length > 1) fail(errorCode);
  return value;
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function constantTimeEqual(left: string, right: string) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a[index] ^ b[index];
  }
  return mismatch === 0;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s,]+)$/iu.exec(authorization);
  return match?.[1] ?? '';
}

function machineCode(error: unknown, fallback: string) {
  const candidate =
    error && typeof error === 'object'
      ? String(
          (error as { code?: unknown; statusCode?: unknown }).code ??
            (error as { statusCode?: unknown }).statusCode ??
            '',
        )
      : '';
  const normalized = candidate
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(normalized) ? normalized : fallback;
}

async function rpc(client: ReturnType<typeof createClient>, name: string, args: object) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

function safeStorageEntryName(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    fail('STORAGE_ENTRY_NAME_INVALID');
  }
  return value;
}

async function listPrefix(client: ReturnType<typeof createClient>, storagePrefix: string) {
  const root = storagePrefix.slice(0, -1);
  if (storagePrefix !== `${root}/` || !UUID_PATTERN.test(root)) {
    fail('STORAGE_PREFIX_INVALID');
  }
  const pendingFolders = [root];
  const knownFolders = new Set([root]);
  const visitedFolders = new Set<string>();
  const objects = new Set<string>();
  let listRequests = 0;

  while (pendingFolders.length > 0) {
    const folder = pendingFolders.shift()!;
    if (visitedFolders.has(folder)) continue;
    visitedFolders.add(folder);
    for (let offset = 0; ; ) {
      listRequests += 1;
      if (listRequests > MAX_LIST_REQUESTS_PER_PREFIX) fail('STORAGE_LIST_LIMIT');
      const { data, error } = await client.storage.from(AVATAR_BUCKET).list(folder, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw error;
      if (!Array.isArray(data)) fail('STORAGE_LIST_RESPONSE_INVALID');
      const entries = data;
      for (const entry of entries) {
        if (!isRecord(entry)) fail('STORAGE_LIST_ENTRY_INVALID');
        const name = safeStorageEntryName(entry.name);
        const path = `${folder}/${name}`;
        if (utf8Length(path) > MAX_OBJECT_KEY_BYTES) fail('STORAGE_OBJECT_KEY_LIMIT');
        if (entry.id === null) {
          if (entry.metadata !== null) fail('STORAGE_FOLDER_ENTRY_INVALID');
          if (!knownFolders.has(path)) {
            if (knownFolders.size >= MAX_FOLDERS_PER_PREFIX) fail('STORAGE_FOLDER_LIMIT');
            knownFolders.add(path);
            pendingFolders.push(path);
          }
        } else {
          if (typeof entry.id !== 'string' || entry.id.length === 0) {
            fail('STORAGE_FILE_ENTRY_INVALID');
          }
          objects.add(path);
          if (objects.size > MAX_OBJECTS_PER_PREFIX) fail('STORAGE_OBJECT_LIMIT');
        }
      }
      if (entries.length < PAGE_SIZE) break;
      offset += entries.length;
    }
  }
  return [...objects];
}

async function removeObjects(client: ReturnType<typeof createClient>, objects: string[]) {
  for (let index = 0; index < objects.length; index += PAGE_SIZE) {
    const batch = objects.slice(index, index + PAGE_SIZE);
    if (batch.length === 0) continue;
    const { error } = await client.storage.from(AVATAR_BUCKET).remove(batch);
    if (error) throw error;
  }
}

async function objectExists(client: ReturnType<typeof createClient>, objectKey: string) {
  const { data, error } = await client.storage
    .from(AVATAR_BUCKET)
    .download(objectKey, {}, { cache: 'no-store' });
  if (!error && data) return true;
  const status = Number(
    (error as { status?: unknown; statusCode?: unknown } | null)?.status ??
      (error as { statusCode?: unknown } | null)?.statusCode,
  );
  const statusCode = String(
    (error as { statusCode?: unknown } | null)?.statusCode ?? '',
  ).toLowerCase();
  if (status === 404 || statusCode === '404' || statusCode === 'not_found') {
    return false;
  }
  throw error ?? new ReconcilerError('STORAGE_DOWNLOAD_FAILED');
}

function assertAvatarCompletion(value: unknown, operationToken: string, expectedState: string) {
  if (!isRecord(value)) fail('AVATAR_COMPLETION_INVALID');
  const returnedToken = parseUuid(
    value.operationToken,
    'AVATAR_COMPLETION_OPERATION_TOKEN_INVALID',
  );
  if (returnedToken !== operationToken || value.status !== expectedState) {
    fail('AVATAR_COMPLETION_INVALID');
  }
}

async function retryAvatarOperation(
  client: ReturnType<typeof createClient>,
  workerId: string,
  rawOperationToken: unknown,
  error: unknown,
) {
  let operationToken: string;
  try {
    operationToken = parseUuid(rawOperationToken, 'AVATAR_OPERATION_TOKEN_INVALID');
  } catch {
    return;
  }
  await rpc(client, 'complete_profile_avatar_reconciliation', {
    p_operation_token: operationToken,
    p_worker_id: workerId,
    p_outcome: 'retry',
    p_error_code: machineCode(error, 'AVATAR_RECONCILE_RETRY'),
  }).catch(() => undefined);
}

async function reconcileAvatarOperation(
  client: ReturnType<typeof createClient>,
  workerId: string,
  rawOperation: unknown,
) {
  try {
    const operation = parseAvatarClaim(rawOperation);
    const manifest = await rpc(client, 'get_profile_avatar_manifest', {
      p_user_id: operation.userId,
    });
    const committedObjectKey = parseManifestObjectKey(manifest, operation.userId);
    if (operation.state === 'committed') {
      if (operation.previousObjectKey && operation.previousObjectKey !== committedObjectKey) {
        await removeObjects(client, [operation.previousObjectKey]);
        if (await objectExists(client, operation.previousObjectKey)) {
          fail('OLD_AVATAR_SURVIVED');
        }
      }
    } else {
      if (operation.objectKey === committedObjectKey) fail('AVATAR_MANIFEST_CONFLICT');
      await removeObjects(client, [operation.objectKey]);
      if (await objectExists(client, operation.objectKey)) fail('STAGING_AVATAR_SURVIVED');
    }
    const completion = await rpc(client, 'complete_profile_avatar_reconciliation', {
      p_operation_token: operation.operationToken,
      p_worker_id: workerId,
      p_outcome: 'cleaned',
      p_error_code: null,
    });
    assertAvatarCompletion(
      completion,
      operation.operationToken,
      operation.state === 'committed' ? 'committed' : 'aborted',
    );
    return true;
  } catch (error) {
    await retryAvatarOperation(
      client,
      workerId,
      isRecord(rawOperation) ? rawOperation.operationToken : null,
      error,
    );
    return false;
  }
}

function assertCleanupAdvance(value: unknown, tombstoneId: string) {
  if (!isRecord(value)) fail('STORAGE_CLEANUP_ADVANCE_INVALID');
  const returnedId = parseUuid(value.tombstoneId, 'STORAGE_TOMBSTONE_ID_INVALID');
  const state = requiredText(value, 'state', 'STORAGE_TOMBSTONE_STATE_INVALID');
  if (returnedId !== tombstoneId || !ACCOUNT_CLEANUP_ADVANCE_STATES.has(state)) {
    fail('STORAGE_CLEANUP_ADVANCE_INVALID');
  }
  return state;
}

async function purgeAccount(client: ReturnType<typeof createClient>, userId: string) {
  const result = await rpc(client, 'purge_user_account', { p_target_id: userId });
  if (!isRecord(result) || result.userId !== userId) {
    fail('ACCOUNT_PURGE_NOT_CONFIRMED');
  }
  const purgeConfirmed =
    (result.deleted === true && result.postPurgeCleanupPending === true) ||
    (result.deleted === false &&
      result.alreadyAbsent === true &&
      result.postPurgeCleanupPending === true);
  if (!purgeConfirmed) {
    fail('ACCOUNT_PURGE_NOT_CONFIRMED');
  }
}

async function retryAccountCleanup(
  client: ReturnType<typeof createClient>,
  workerId: string,
  rawTombstone: unknown,
  error: unknown,
) {
  if (!isRecord(rawTombstone)) return;
  let tombstoneId: string;
  try {
    tombstoneId = parseUuid(rawTombstone.tombstoneId, 'STORAGE_TOMBSTONE_ID_INVALID');
  } catch {
    return;
  }
  await rpc(client, 'advance_account_storage_cleanup', {
    p_tombstone_id: tombstoneId,
    p_worker_id: workerId,
    p_outcome: 'retry',
    p_error_code: machineCode(error, 'STORAGE_CLEANUP_RETRY'),
  }).catch(() => undefined);
}

async function reconcileAccountCleanup(
  client: ReturnType<typeof createClient>,
  workerId: string,
  rawTombstone: unknown,
) {
  try {
    const tombstone = parseTombstoneClaim(rawTombstone);
    if (tombstone.state === 'storage_cleared') {
      await purgeAccount(client, tombstone.userId);
      return true;
    }
    const objects = await listPrefix(client, tombstone.storagePrefix);
    await removeObjects(client, objects);
    const remaining = await listPrefix(client, tombstone.storagePrefix);
    const advance = await rpc(client, 'advance_account_storage_cleanup', {
      p_tombstone_id: tombstone.tombstoneId,
      p_worker_id: workerId,
      p_outcome: remaining.length === 0 ? 'empty' : 'nonempty',
      p_error_code: remaining.length === 0 ? null : 'STORAGE_PREFIX_NOT_EMPTY',
    });
    const nextState = assertCleanupAdvance(advance, tombstone.tombstoneId);
    if (nextState === 'storage_cleared') {
      await purgeAccount(client, tombstone.userId);
    }
    return remaining.length === 0;
  } catch (error) {
    await retryAccountCleanup(client, workerId, rawTombstone, error);
    return false;
  }
}

async function reconcileStalePresentations(client: ReturnType<typeof createClient>) {
  const claim = await rpc(client, 'claim_stale_course_presentations', {
    p_limit: MAX_STALE_PRESENTATIONS_PER_RUN,
    p_ttl_hours: 24,
    p_lease_minutes: 10,
  });
  const items = parseStalePresentationClaim(claim);
  const cleanedIds: string[] = [];
  let failed = 0;
  for (const item of items) {
    try {
      const objectKeys = [...new Set([item.objectKey, item.thumbnailPath].filter(Boolean))];
      const { error } = await client.storage.from(item.bucket).remove(objectKeys);
      if (error) throw error;
      cleanedIds.push(item.id);
    } catch {
      failed += 1;
    }
  }
  if (cleanedIds.length > 0) {
    await rpc(client, 'complete_course_presentation_cleanup', {
      p_presentation_ids: cleanedIds,
    });
  }
  return { claimed: items.length, completed: cleanedIds.length, failed };
}

async function claimOne(
  client: ReturnType<typeof createClient>,
  rpcName: string,
  workerId: string,
  errorCode: string,
) {
  const claims = claimArray(
    await rpc(client, rpcName, { p_worker_id: workerId, p_limit: 1 }),
    errorCode,
  );
  return claims[0] ?? null;
}

const NO_STORE_HEADERS = { 'cache-control': 'no-store' };

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...NO_STORE_HEADERS, allow: 'POST' },
    });
  }
  try {
    const secret = requiredEnv('STORAGE_RECONCILER_SECRET');
    const secretLength = utf8Length(secret);
    if (
      secretLength < 32 ||
      secretLength > MAX_BEARER_BYTES ||
      secret === EXAMPLE_RECONCILER_SECRET
    ) {
      fail('STORAGE_RECONCILER_SECRET_INVALID');
    }
    const token = bearerToken(request);
    if (utf8Length(token) > MAX_BEARER_BYTES || !(await constantTimeEqual(token, secret))) {
      return new Response('Forbidden', { status: 403, headers: NO_STORE_HEADERS });
    }
    const client = createClient(
      requiredEnv('SUPABASE_URL'),
      requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const workerId = crypto.randomUUID();
    const startedAt = Date.now();
    const avatarDeadline = startedAt + AVATAR_WORK_BUDGET_MS;
    const totalDeadline = startedAt + TOTAL_WORK_BUDGET_MS;

    let avatarClaimed = 0;
    let avatarCompleted = 0;
    let avatarFailed = 0;
    while (avatarClaimed < MAX_AVATAR_OPERATIONS_PER_RUN && Date.now() < avatarDeadline) {
      const operation = await claimOne(
        client,
        'claim_profile_avatar_reconciliation',
        workerId,
        'AVATAR_CLAIM_RESPONSE_INVALID',
      );
      if (operation === null) break;
      avatarClaimed += 1;
      if (await reconcileAvatarOperation(client, workerId, operation)) avatarCompleted += 1;
      else avatarFailed += 1;
    }

    let accountsClaimed = 0;
    let accountsAdvanced = 0;
    let accountsFailed = 0;
    while (accountsClaimed < MAX_ACCOUNT_TOMBSTONES_PER_RUN && Date.now() < totalDeadline) {
      const tombstone = await claimOne(
        client,
        'claim_account_storage_cleanup',
        workerId,
        'STORAGE_CLAIM_RESPONSE_INVALID',
      );
      if (tombstone === null) break;
      accountsClaimed += 1;
      if (await reconcileAccountCleanup(client, workerId, tombstone)) accountsAdvanced += 1;
      else accountsFailed += 1;
    }

    const presentationCleanup =
      Date.now() < totalDeadline
        ? await reconcileStalePresentations(client)
        : { claimed: 0, completed: 0, failed: 0 };

    await Promise.all([
      rpc(client, 'prune_terminal_avatar_upload_operations', { p_limit: 500 }),
      rpc(client, 'prune_signup_legal_operations', { p_limit: 100 }),
      rpc(client, 'prune_terminal_auth_admin_outbox', { p_limit: 100 }),
      rpc(client, 'prune_account_storage_cleanup_tombstones', { p_limit: 100 }),
      rpc(client, 'prune_coarse_ip_rate_limits', { p_limit: 500 }),
      rpc(client, 'prune_learning_history_delete_receipts', { p_limit: 500 }),
    ]);
    return Response.json(
      {
        ok: true,
        avatarClaimed,
        avatarCompleted,
        avatarFailed,
        accountsClaimed,
        accountsAdvanced,
        accountsFailed,
        stalePresentationsClaimed: presentationCleanup.claimed,
        stalePresentationsCompleted: presentationCleanup.completed,
        stalePresentationsFailed: presentationCleanup.failed,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('STORAGE_RECONCILER_FAILED', {
      code: machineCode(error, 'STORAGE_RECONCILER_FAILED'),
    });
    return Response.json(
      { error: 'STORAGE_RECONCILER_FAILED' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
});
