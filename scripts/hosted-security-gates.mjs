import crypto from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import {
  assertCleanLoadTestBaseline,
  assertDisposableProjectMarker,
  assertLoadTestTarget,
} from './load-test-safety.mjs';

const AVATAR_BUCKET = 'profile-avatars';
const AVATAR_CONTENT_TYPE = 'image/webp';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'u');
const POSTGREST_DENIAL_STATUSES = new Set([401, 403, 404, 406]);
const STORAGE_DENIAL_STATUSES = new Set([400, 401, 403, 404, 409]);
const STORAGE_DATABASE_DENIAL_MESSAGE = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED';
const STORAGE_MISSING_STATUSES = new Set([400, 404]);
const CLEANUP_CLAIM_STATES = new Set([
  'sweeping',
  'empty_once',
  'storage_cleared',
  'post_purge_cleanup',
  'post_purge_empty_once',
]);
const CLEANUP_ADVANCE_STATES = new Set([
  'cleanup_pending',
  'empty_once',
  'storage_cleared',
  'post_purge_cleanup',
  'post_purge_empty_once',
  'db_purged',
]);
const DEFAULT_CLEANUP_TIMEOUT_MS = 55 * 60 * 1_000;
const DEFAULT_CLEANUP_POLL_MS = 30 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1_000;
const POST_PURGE_DELAY_MS = 15 * 60 * 1_000;
const STORAGE_PAGE_SIZE = 100;
const MAX_STORAGE_OBJECTS = 1_000;
const MAX_STORAGE_FOLDERS = 64;
const MAX_STORAGE_LIST_REQUESTS = 128;
const CREATE_RECONCILE_PAGE_SIZE = 100;
const CREATE_RECONCILE_MAX_USERS = 1_000;

export class HostedSecurityGateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HostedSecurityGateError';
    this.code = code;
  }
}

export class HostedSecurityGateRunError extends Error {
  constructor(code, report) {
    super(code);
    this.name = 'HostedSecurityGateRunError';
    this.code = code;
    this.report = report;
  }
}

function fail(code) {
  throw new HostedSecurityGateError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) fail(`MISSING_${name}`);
  return value;
}

function secretEnv(env, name) {
  const value = exactEnv(env, name).trim();
  if (value.length === 0) fail(`MISSING_${name}`);
  return value;
}

function durationEnv(env, name, fallback, minimum, maximum) {
  if (env[name] === undefined) return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`INVALID_${name}`);
  }
  return value;
}

function uuid(value, code) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(code);
  return value;
}

function safeErrorCode(error, fallback = 'UNEXPECTED_HOSTED_GATE_FAILURE') {
  return error instanceof HostedSecurityGateError ? error.code : fallback;
}

function rethrowOrFail(error, code) {
  if (error instanceof HostedSecurityGateError) throw error;
  fail(code);
}

export function createRequestGuard({
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = Date.now,
  getDeadline = () => Number.POSITIVE_INFINITY,
} = {}) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    fail('REQUEST_TIMEOUT_INVALID');
  }

  function effectiveDeadline(deadlineOverride) {
    if (deadlineOverride !== undefined) return deadlineOverride;
    const candidate = getDeadline();
    return Number.isFinite(candidate) ? candidate : Number.POSITIVE_INFINITY;
  }

  function duration(deadlineOverride) {
    const deadline = effectiveDeadline(deadlineOverride);
    const deadlineRemaining = Number.isFinite(deadline)
      ? Math.floor(deadline - now())
      : requestTimeoutMs;
    const milliseconds = Math.min(requestTimeoutMs, deadlineRemaining);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
      fail('REQUEST_DEADLINE_EXCEEDED');
    }
    return milliseconds;
  }

  async function call(operation, code = 'REMOTE_OPERATION', deadlineOverride) {
    const milliseconds = duration(deadlineOverride);
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new HostedSecurityGateError(`${code}_TIMEOUT`)),
            milliseconds,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function fetchBounded(fetchImpl, input, init = {}, code = 'REMOTE_FETCH', deadlineOverride) {
    if (typeof fetchImpl !== 'function') fail(`${code}_UNAVAILABLE`);
    const timeoutSignal = AbortSignal.timeout(duration(deadlineOverride));
    const signals = [timeoutSignal];
    if (init.signal instanceof AbortSignal) signals.push(init.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return call(
      () => fetchImpl(input, { ...init, signal }),
      code,
      deadlineOverride,
    );
  }

  return Object.freeze({ call, fetch: fetchBounded });
}

function supabaseOptions(boundedFetch) {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: boundedFetch },
  };
}

export function resolveHostedGateConfig(env = process.env) {
  const url = exactEnv(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const disposableRef = exactEnv(env, 'SAFETYHUB_LOAD_TEST_PROJECT_REF');
  const confirmation = exactEnv(env, 'SAFETYHUB_LOAD_TEST_CONFIRM');
  const marker = exactEnv(env, 'SAFETYHUB_LOAD_TEST_MARKER');

  let projectRef;
  try {
    projectRef = assertLoadTestTarget({
      url,
      disposableRef,
      confirmation,
      marker,
    });
  } catch {
    fail('TARGET_PREFLIGHT_REFUSED');
  }

  return Object.freeze({
    url,
    projectRef,
    publishableKey: secretEnv(env, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    secretKey: secretEnv(env, 'SUPABASE_SECRET_KEY'),
    managementToken: secretEnv(env, 'SUPABASE_ACCESS_TOKEN'),
    cleanupTimeoutMs: durationEnv(
      env,
      'SAFETYHUB_HOSTED_CLEANUP_TIMEOUT_MS',
      DEFAULT_CLEANUP_TIMEOUT_MS,
      55 * 60 * 1_000,
      2 * 60 * 60 * 1_000,
    ),
    cleanupPollMs: durationEnv(
      env,
      'SAFETYHUB_HOSTED_CLEANUP_POLL_MS',
      DEFAULT_CLEANUP_POLL_MS,
      1_000,
      60_000,
    ),
    requestTimeoutMs: durationEnv(
      env,
      'SAFETYHUB_HOSTED_REQUEST_TIMEOUT_MS',
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      30_000,
    ),
  });
}

function statusFromError(error) {
  if (!isRecord(error)) return null;
  for (const candidate of [error.status, error.statusCode, error.originalError?.status]) {
    const status = Number(candidate);
    if (Number.isInteger(status)) return status;
  }
  return null;
}

export function assertStorageDenied(result, code = 'STORAGE_OPERATION_NOT_DENIED') {
  const status = statusFromError(result?.error);
  const exactDatabaseDenial =
    status === 500 &&
    result?.error?.name === 'StorageApiError' &&
    (result?.error?.statusCode === 'DatabaseError' || result?.error?.code === 'DatabaseError') &&
    result?.error?.message === STORAGE_DATABASE_DENIAL_MESSAGE;
  if (!result?.error || (!STORAGE_DENIAL_STATUSES.has(status) && !exactDatabaseDenial)) fail(code);
  return status;
}

export function assertPostgrestDenied(response, code = 'POSTGREST_OPERATION_NOT_DENIED') {
  if (!response || !POSTGREST_DENIAL_STATUSES.has(response.status)) fail(code);
  return response.status;
}

async function rpcData(client, name, args, request = createRequestGuard(), deadline) {
  let result;
  try {
    result = await request.call(
      () => client.rpc(name, args),
      `${name.toUpperCase()}_RPC`,
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, `${name.toUpperCase()}_RPC_UNAVAILABLE`);
  }
  if (result?.error) fail(`${name.toUpperCase()}_RPC_FAILED`);
  return result?.data;
}

function parseOperation(value, userId, expectedStatus, expectedToken) {
  if (!isRecord(value)) fail('AVATAR_OPERATION_CONTRACT_INVALID');
  const operationToken = uuid(value.operationToken, 'AVATAR_OPERATION_TOKEN_INVALID');
  if (
    value.status !== expectedStatus ||
    (expectedToken !== undefined && operationToken !== expectedToken) ||
    value.objectKey !== `${userId}/objects/${operationToken}.webp`
  ) {
    fail('AVATAR_OPERATION_CONTRACT_INVALID');
  }
  return { operationToken, objectKey: value.objectKey };
}

export function parsePreparedAvatarOperation(value, userId) {
  return parseOperation(value, uuid(userId, 'AVATAR_USER_ID_INVALID'), 'prepared');
}

function parseManifest(value, userId, operationToken, sha256, byteLength) {
  if (
    !isRecord(value) ||
    value.objectKey !== `${userId}/objects/${operationToken}.webp` ||
    value.sha256 !== sha256 ||
    value.bytes !== byteLength ||
    value.legacyImported !== false
  ) {
    fail('AVATAR_MANIFEST_CONTRACT_INVALID');
  }
  return value;
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  init,
  code,
  request = createRequestGuard(),
  deadline,
) {
  try {
    return await request.fetch(fetchImpl, url, init, code, deadline);
  } catch (error) {
    rethrowOrFail(error, code);
  }
}

function postgrestHeaders(publishableKey, bearer, extra = {}) {
  return {
    accept: 'application/json',
    apikey: publishableKey,
    authorization: `Bearer ${bearer}`,
    ...extra,
  };
}

async function postgrestDenialProbe({
  fetchImpl,
  url,
  publishableKey,
  bearer,
  path,
  method = 'GET',
  body,
  headers,
  code,
  request,
  deadline,
}) {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${url}${path}`,
    {
      method,
      headers: postgrestHeaders(publishableKey, bearer, {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    `${code}_REQUEST_FAILED`,
    request,
    deadline,
  );
  assertPostgrestDenied(response, code);
}

export async function runPostgrestAclGates({
  fetchImpl = globalThis.fetch,
  url,
  publishableKey,
  accessToken,
  userId,
  randomUUID = crypto.randomUUID,
  request = createRequestGuard(),
  deadline,
}) {
  const privatePath = '/rest/v1/avatar_upload_operations?select=token&limit=1';
  const privateHeaders = { 'accept-profile': 'private' };
  const workerId = randomUUID();
  uuid(workerId, 'ACL_WORKER_ID_INVALID');

  await postgrestDenialProbe({
    fetchImpl,
    url,
    publishableKey,
    bearer: publishableKey,
    path: privatePath,
    headers: privateHeaders,
    code: 'ANON_PRIVATE_SCHEMA_EXPOSED',
    request,
    deadline,
  });
  await postgrestDenialProbe({
    fetchImpl,
    url,
    publishableKey,
    bearer: accessToken,
    path: privatePath,
    headers: privateHeaders,
    code: 'AUTH_PRIVATE_SCHEMA_EXPOSED',
    request,
    deadline,
  });

  const claimPath = '/rest/v1/rpc/claim_account_storage_cleanup';
  const claimBody = { p_worker_id: workerId, p_limit: 1 };
  await postgrestDenialProbe({
    fetchImpl,
    url,
    publishableKey,
    bearer: publishableKey,
    path: claimPath,
    method: 'POST',
    body: claimBody,
    code: 'ANON_SERVICE_RPC_EXPOSED',
    request,
    deadline,
  });
  await postgrestDenialProbe({
    fetchImpl,
    url,
    publishableKey,
    bearer: accessToken,
    path: claimPath,
    method: 'POST',
    body: claimBody,
    code: 'AUTH_SERVICE_RPC_EXPOSED',
    request,
    deadline,
  });

  await postgrestDenialProbe({
    fetchImpl,
    url,
    publishableKey,
    bearer: accessToken,
    path: '/rest/v1/rpc/consume_business_quota_for_actor',
    method: 'POST',
    body: { p_actor_id: userId, p_action: 'avatar.upload' },
    code: 'AUTH_ACTOR_QUOTA_RPC_EXPOSED',
    request,
    deadline,
  });
  await postgrestDenialProbe({
    fetchImpl,
    url,
    publishableKey,
    bearer: accessToken,
    path: '/rest/v1/rpc/begin_user_account_purge',
    method: 'POST',
    body: { p_target_id: userId },
    code: 'AUTH_ACCOUNT_PURGE_RPC_EXPOSED',
    request,
    deadline,
  });

  return Object.freeze({ denialProbes: 6 });
}

async function assertServiceRpcPresence({ admin, userId, randomUUID, request, deadline }) {
  const workerId = uuid(randomUUID(), 'SERVICE_RPC_WORKER_ID_INVALID');
  const absentUserId = uuid(randomUUID(), 'SERVICE_RPC_USER_ID_INVALID');
  const claims = await rpcData(
    admin,
    'claim_account_storage_cleanup',
    { p_worker_id: workerId, p_limit: 1 },
    request,
    deadline,
  );
  if (!Array.isArray(claims) || claims.length !== 0) {
    fail('SERVICE_RPC_CLEAN_BASELINE_INVALID');
  }
  const quota = await rpcData(
    admin,
    'consume_business_quota_for_actor',
    { p_actor_id: userId, p_action: 'avatar.upload' },
    request,
    deadline,
  );
  if (!isRecord(quota) || quota.allowed !== true || quota.retryAfter !== 0) {
    fail('SERVICE_RPC_QUOTA_CONTRACT_INVALID');
  }
  const absentPurge = await rpcData(
    admin,
    'begin_user_account_purge',
    { p_target_id: absentUserId },
    request,
    deadline,
  );
  if (
    !isRecord(absentPurge) ||
    absentPurge.userId !== absentUserId ||
    absentPurge.exists !== false ||
    absentPurge.pending !== false
  ) {
    fail('SERVICE_RPC_PURGE_CONTRACT_INVALID');
  }
}

async function assertCleanStorageBaseline(admin, request = createRequestGuard(), deadline) {
  let bucket;
  try {
    bucket = await request.call(
      () => admin.storage.getBucket(AVATAR_BUCKET),
      'STORAGE_BUCKET_BASELINE',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'STORAGE_BUCKET_BASELINE_UNAVAILABLE');
  }
  if (bucket?.error || !isRecord(bucket?.data) || bucket.data.public !== false) {
    fail('STORAGE_BUCKET_MUST_EXIST_AND_BE_PRIVATE');
  }

  let listed;
  try {
    listed = await request.call(
      () =>
        admin.storage.from(AVATAR_BUCKET).list('', {
          limit: 1,
          offset: 0,
          sortBy: { column: 'name', order: 'asc' },
        }),
      'STORAGE_BASELINE',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'STORAGE_BASELINE_UNAVAILABLE');
  }
  if (listed?.error || !Array.isArray(listed?.data)) fail('STORAGE_BASELINE_UNAVAILABLE');
  if (listed.data.length !== 0) fail('CLEAN_STORAGE_BASELINE_REQUIRED');
}

async function downloadBytes(
  client,
  objectKey,
  code,
  request = createRequestGuard(),
  deadline,
) {
  let result;
  try {
    result = await request.call(
      () =>
        client.storage.from(AVATAR_BUCKET).download(objectKey, {}, { cache: 'no-store' }),
      code,
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, `${code}_UNAVAILABLE`);
  }
  if (result?.error || !result?.data || typeof result.data.arrayBuffer !== 'function') fail(code);
  return Buffer.from(await result.data.arrayBuffer());
}

function assertExactBytes(actual, expected, expectedSha256, code) {
  const actualSha256 = crypto.createHash('sha256').update(actual).digest('hex');
  if (
    actual.byteLength !== expected.byteLength ||
    actualSha256 !== expectedSha256 ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    fail(code);
  }
}

async function assertObjectMissing(
  admin,
  objectKey,
  code,
  request = createRequestGuard(),
  deadline,
) {
  let result;
  try {
    result = await request.call(
      () => admin.storage.from(AVATAR_BUCKET).download(objectKey, {}, { cache: 'no-store' }),
      code,
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, `${code}_UNAVAILABLE`);
  }
  const status = statusFromError(result?.error);
  if (result?.data || !result?.error || !STORAGE_MISSING_STATUSES.has(status)) fail(code);
}

async function deniedUpload({
  client,
  admin,
  objectKey,
  bytes,
  code,
  request,
  deadline,
  onProbeKey,
}) {
  onProbeKey(objectKey);
  let result;
  try {
    result = await request.call(
      () =>
        client.storage.from(AVATAR_BUCKET).upload(objectKey, bytes, {
          contentType: AVATAR_CONTENT_TYPE,
          cacheControl: '600',
          upsert: false,
        }),
      code,
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, `${code}_UNAVAILABLE`);
  }
  assertStorageDenied(result, code);
  await assertObjectMissing(admin, objectKey, `${code}_OBJECT_VISIBLE`, request, deadline);
}

async function authenticatedManifest(client, request, deadline) {
  const value = await rpcData(client, 'get_my_profile_avatar_manifest', {}, request, deadline);
  return value ?? null;
}

export async function runHostedStorageGates({
  admin,
  authenticated,
  anonymous,
  fetchImpl = globalThis.fetch,
  url,
  userId,
  avatarBytes,
  randomUUID = crypto.randomUUID,
  onOperation = () => undefined,
  onStorageWriteState = () => undefined,
  onProbeKey = () => undefined,
  request = createRequestGuard(),
  deadline,
}) {
  const bytes = Buffer.from(avatarBytes);
  if (bytes.byteLength < 1 || bytes.byteLength > 100 * 1_024) fail('AVATAR_FIXTURE_SIZE_INVALID');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const foreignUserId = uuid(randomUUID(), 'STORAGE_PROBE_UUID_INVALID');
  const foreignToken = uuid(randomUUID(), 'STORAGE_PROBE_UUID_INVALID');
  const wrongToken = uuid(randomUUID(), 'STORAGE_PROBE_UUID_INVALID');

  if ((await authenticatedManifest(authenticated, request, deadline)) !== null) {
    fail('PRECOMMIT_MANIFEST_MUST_BE_EMPTY');
  }

  await deniedUpload({
    client: authenticated,
    admin,
    objectKey: `${foreignUserId}/objects/${foreignToken}.webp`,
    bytes,
    code: 'FOREIGN_PREFIX_UPLOAD_NOT_DENIED',
    request,
    deadline,
    onProbeKey,
  });
  await deniedUpload({
    client: authenticated,
    admin,
    objectKey: `${userId}/objects/${wrongToken}.webp`,
    bytes,
    code: 'UNPREPARED_TOKEN_UPLOAD_NOT_DENIED',
    request,
    deadline,
    onProbeKey,
  });
  await deniedUpload({
    client: authenticated,
    admin,
    objectKey: `${userId}/avatar.webp`,
    bytes,
    code: 'LEGACY_KEY_UPLOAD_NOT_DENIED',
    request,
    deadline,
    onProbeKey,
  });

  const begun = parseOperation(
    await rpcData(admin, 'begin_profile_avatar_upload', {
      p_user_id: userId,
      p_expected_sha256: sha256,
      p_expected_bytes: bytes.byteLength,
    }, request, deadline),
    userId,
    'prepared',
  );
  onOperation(begun);

  onStorageWriteState('ambiguous');
  await deniedUpload({
    client: anonymous,
    admin,
    objectKey: begun.objectKey,
    bytes,
    code: 'ANON_PREPARED_UPLOAD_NOT_DENIED',
    request,
    deadline,
    onProbeKey,
  });
  onStorageWriteState('not_started');

  let upload;
  onStorageWriteState('ambiguous');
  try {
    upload = await request.call(
      () =>
        authenticated.storage.from(AVATAR_BUCKET).upload(begun.objectKey, bytes, {
          contentType: AVATAR_CONTENT_TYPE,
          cacheControl: '600',
          upsert: false,
        }),
      'AUTHENTICATED_IMMUTABLE_UPLOAD',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'AUTHENTICATED_IMMUTABLE_UPLOAD_UNAVAILABLE');
  }
  if (upload?.error || upload?.data?.path !== begun.objectKey) {
    fail('AUTHENTICATED_IMMUTABLE_UPLOAD_FAILED');
  }
  onStorageWriteState('settled');

  let precommitDownload;
  try {
    precommitDownload = await request.call(
      () =>
        authenticated.storage
          .from(AVATAR_BUCKET)
          .download(begun.objectKey, {}, { cache: 'no-store' }),
      'PRECOMMIT_DOWNLOAD_PROBE',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'PRECOMMIT_DOWNLOAD_PROBE_UNAVAILABLE');
  }
  assertStorageDenied(precommitDownload, 'PRECOMMIT_OBJECT_READABLE');

  const backendBytes = await downloadBytes(
    admin,
    begun.objectKey,
    'ADMIN_UPLOAD_READBACK_FAILED',
    request,
    deadline,
  );
  assertExactBytes(backendBytes, bytes, sha256, 'ADMIN_UPLOAD_READBACK_MISMATCH');

  parseOperation(
    await rpcData(admin, 'finish_profile_avatar_storage_write', {
      p_user_id: userId,
      p_operation_token: begun.operationToken,
      p_error_code: null,
    }, request, deadline),
    userId,
    'prepared',
    begun.operationToken,
  );
  parseOperation(
    await rpcData(admin, 'mark_profile_avatar_staged', {
      p_user_id: userId,
      p_operation_token: begun.operationToken,
      p_observed_sha256: sha256,
      p_observed_bytes: bytes.byteLength,
    }, request, deadline),
    userId,
    'staged',
    begun.operationToken,
  );

  if ((await authenticatedManifest(authenticated, request, deadline)) !== null) {
    fail('STAGED_MANIFEST_MUST_NOT_BE_PUBLISHED');
  }

  parseOperation(
    await rpcData(admin, 'finalize_profile_avatar_upload', {
      p_user_id: userId,
      p_operation_token: begun.operationToken,
    }, request, deadline),
    userId,
    'committed',
    begun.operationToken,
  );
  // From this point the manifest is durable. Account purge, not precommit
  // abort compensation, owns cleanup if any later read-only assertion fails.
  onOperation(undefined);

  const serviceManifest = parseManifest(
    await rpcData(
      admin,
      'get_profile_avatar_manifest',
      { p_user_id: userId },
      request,
      deadline,
    ),
    userId,
    begun.operationToken,
    sha256,
    bytes.byteLength,
  );
  parseManifest(
    await authenticatedManifest(authenticated, request, deadline),
    userId,
    begun.operationToken,
    sha256,
    bytes.byteLength,
  );

  const ownerBytes = await downloadBytes(
    authenticated,
    serviceManifest.objectKey,
    'COMMITTED_OWNER_DOWNLOAD_FAILED',
    request,
    deadline,
  );
  assertExactBytes(ownerBytes, bytes, sha256, 'COMMITTED_OWNER_DOWNLOAD_MISMATCH');

  let anonDownload;
  try {
    anonDownload = await request.call(
      () =>
        anonymous.storage
          .from(AVATAR_BUCKET)
          .download(serviceManifest.objectKey, {}, { cache: 'no-store' }),
      'ANON_DOWNLOAD_PROBE',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'ANON_DOWNLOAD_PROBE_UNAVAILABLE');
  }
  assertStorageDenied(anonDownload, 'COMMITTED_OBJECT_PUBLICLY_READABLE');

  let signed;
  try {
    signed = await request.call(
      () =>
        admin.storage.from(AVATAR_BUCKET).createSignedUrl(serviceManifest.objectKey, 600),
      'SIGNED_URL_CREATION',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'SIGNED_URL_CREATION_UNAVAILABLE');
  }
  if (signed?.error || typeof signed?.data?.signedUrl !== 'string') {
    fail('SIGNED_URL_CREATION_FAILED');
  }
  let signedUrl;
  try {
    signedUrl = new URL(signed.data.signedUrl);
  } catch {
    fail('SIGNED_URL_CONTRACT_INVALID');
  }
  const targetOrigin = new URL(url).origin;
  const signedPathPrefix = `/storage/v1/object/sign/${AVATAR_BUCKET}/`;
  let signedObjectKey;
  try {
    signedObjectKey = decodeURIComponent(signedUrl.pathname.slice(signedPathPrefix.length));
  } catch {
    fail('SIGNED_URL_CONTRACT_INVALID');
  }
  if (
    signedUrl.origin !== targetOrigin ||
    !signedUrl.pathname.startsWith(signedPathPrefix) ||
    signedObjectKey !== serviceManifest.objectKey ||
    !signedUrl.searchParams.has('token')
  ) {
    fail('SIGNED_URL_CONTRACT_INVALID');
  }
  const signedResponse = await fetchWithTimeout(
    fetchImpl,
    signedUrl,
    { method: 'GET', headers: { accept: AVATAR_CONTENT_TYPE } },
    'SIGNED_URL_FETCH_UNAVAILABLE',
    request,
    deadline,
  );
  if (!signedResponse?.ok) fail('SIGNED_URL_FETCH_FAILED');
  let signedBuffer;
  try {
    signedBuffer = await request.call(
      () => signedResponse.arrayBuffer(),
      'SIGNED_URL_BODY_READ',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'SIGNED_URL_BODY_READ_UNAVAILABLE');
  }
  const signedBytes = Buffer.from(signedBuffer);
  assertExactBytes(signedBytes, bytes, sha256, 'SIGNED_URL_READBACK_MISMATCH');

  let overwrite;
  try {
    overwrite = await request.call(
      () =>
        authenticated.storage.from(AVATAR_BUCKET).upload(serviceManifest.objectKey, bytes, {
          contentType: AVATAR_CONTENT_TYPE,
          cacheControl: '600',
          upsert: true,
        }),
      'BROWSER_OVERWRITE_PROBE',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'BROWSER_OVERWRITE_PROBE_UNAVAILABLE');
  }
  assertStorageDenied(overwrite, 'BROWSER_OVERWRITE_NOT_DENIED');

  let deletion;
  try {
    deletion = await request.call(
      () => authenticated.storage.from(AVATAR_BUCKET).remove([serviceManifest.objectKey]),
      'BROWSER_DELETE_PROBE',
      deadline,
    );
  } catch (error) {
    rethrowOrFail(error, 'BROWSER_DELETE_PROBE_UNAVAILABLE');
  }
  assertStorageDenied(deletion, 'BROWSER_DELETE_NOT_DENIED');

  const finalBytes = await downloadBytes(
    admin,
    serviceManifest.objectKey,
    'FINAL_OBJECT_READBACK_FAILED',
    request,
    deadline,
  );
  assertExactBytes(finalBytes, bytes, sha256, 'FINAL_OBJECT_CHANGED_AFTER_DENIED_MUTATION');

  return Object.freeze({
    positiveUploads: 1,
    negativeUploads: 4,
    deniedReads: 2,
    deniedMutations: 2,
  });
}

function safeStorageEntryName(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    fail('CLEANUP_STORAGE_ENTRY_INVALID');
  }
  return value;
}

async function listStoragePrefix(
  admin,
  userId,
  request = createRequestGuard(),
  deadline,
) {
  const pendingFolders = [userId];
  const knownFolders = new Set(pendingFolders);
  const visitedFolders = new Set();
  const objects = new Set();
  let listRequests = 0;

  while (pendingFolders.length > 0) {
    const folder = pendingFolders.shift();
    if (visitedFolders.has(folder)) continue;
    visitedFolders.add(folder);
    for (let offset = 0; ; ) {
      listRequests += 1;
      if (listRequests > MAX_STORAGE_LIST_REQUESTS) fail('CLEANUP_STORAGE_LIST_LIMIT');
      let result;
      try {
        result = await request.call(
          () =>
            admin.storage.from(AVATAR_BUCKET).list(folder, {
              limit: STORAGE_PAGE_SIZE,
              offset,
              sortBy: { column: 'name', order: 'asc' },
            }),
          'CLEANUP_STORAGE_LIST',
          deadline,
        );
      } catch (error) {
        rethrowOrFail(error, 'CLEANUP_STORAGE_LIST_UNAVAILABLE');
      }
      if (result?.error || !Array.isArray(result?.data)) fail('CLEANUP_STORAGE_LIST_FAILED');
      for (const entry of result.data) {
        if (!isRecord(entry)) fail('CLEANUP_STORAGE_ENTRY_INVALID');
        const name = safeStorageEntryName(entry.name);
        const path = `${folder}/${name}`;
        if (entry.id === null) {
          if (entry.metadata !== null) fail('CLEANUP_STORAGE_FOLDER_INVALID');
          if (!knownFolders.has(path)) {
            if (knownFolders.size >= MAX_STORAGE_FOLDERS) fail('CLEANUP_STORAGE_FOLDER_LIMIT');
            knownFolders.add(path);
            pendingFolders.push(path);
          }
        } else {
          if (typeof entry.id !== 'string' || entry.id.length === 0) {
            fail('CLEANUP_STORAGE_FILE_INVALID');
          }
          objects.add(path);
          if (objects.size > MAX_STORAGE_OBJECTS) fail('CLEANUP_STORAGE_OBJECT_LIMIT');
        }
      }
      if (result.data.length < STORAGE_PAGE_SIZE) break;
      offset += result.data.length;
    }
  }
  return [...objects];
}

async function removeStorageObjects(
  admin,
  objects,
  request = createRequestGuard(),
  deadline,
) {
  for (let index = 0; index < objects.length; index += STORAGE_PAGE_SIZE) {
    const batch = objects.slice(index, index + STORAGE_PAGE_SIZE);
    let result;
    try {
      result = await request.call(
        () => admin.storage.from(AVATAR_BUCKET).remove(batch),
        'CLEANUP_STORAGE_REMOVE',
        deadline,
      );
    } catch (error) {
      rethrowOrFail(error, 'CLEANUP_STORAGE_REMOVE_UNAVAILABLE');
    }
    if (result?.error) fail('CLEANUP_STORAGE_REMOVE_FAILED');
  }
}

function serverTimestamp(value, code) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(code);
  return timestamp;
}

async function waitUntil({ target, deadline, now, sleep, pollMs }) {
  while (now() < target) {
    if (now() >= deadline) fail('CLEANUP_DEADLINE_EXCEEDED');
    const remaining = Math.min(target - now(), deadline - now(), pollMs);
    await sleep(Math.max(1, remaining));
  }
}

function parseCleanupClaim(value, userId, tombstoneId) {
  if (!Array.isArray(value) || value.length > 1) fail('CLEANUP_CLAIM_CONTRACT_INVALID');
  if (value.length === 0) return null;
  const claim = value[0];
  if (
    !isRecord(claim) ||
    claim.userId !== userId ||
    claim.tombstoneId !== tombstoneId ||
    claim.storagePrefix !== `${userId}/` ||
    !CLEANUP_CLAIM_STATES.has(claim.state)
  ) {
    fail('CLEANUP_CLAIM_CONTRACT_INVALID');
  }
  return claim;
}

function parseCleanupAdvance(value, tombstoneId) {
  if (
    !isRecord(value) ||
    value.tombstoneId !== tombstoneId ||
    !CLEANUP_ADVANCE_STATES.has(value.state)
  ) {
    fail('CLEANUP_ADVANCE_CONTRACT_INVALID');
  }
  return value;
}

export async function runOfficialAccountPurge({
  admin,
  userId,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  pollMs = DEFAULT_CLEANUP_POLL_MS,
  postPurgeDelayMs = POST_PURGE_DELAY_MS,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  randomUUID = crypto.randomUUID,
  onState = () => undefined,
  request,
  deadline,
}) {
  uuid(userId, 'CLEANUP_USER_ID_INVALID');
  const cleanupDeadline = deadline ?? now() + timeoutMs;
  const requestGuard =
    request ?? createRequestGuard({ now, getDeadline: () => cleanupDeadline });
  const begun = await rpcData(
    admin,
    'begin_user_account_purge',
    { p_target_id: userId },
    requestGuard,
    cleanupDeadline,
  );
  if (
    !isRecord(begun) ||
    begun.userId !== userId ||
    begun.exists !== true ||
    begun.pending !== true
  ) {
    fail('CLEANUP_BEGIN_CONTRACT_INVALID');
  }
  const tombstoneId = uuid(begun.tombstoneId, 'CLEANUP_TOMBSTONE_ID_INVALID');
  let state = begun.state;
  onState(state);
  await waitUntil({
    target: serverTimestamp(begun.cleanupNotBefore, 'CLEANUP_NOT_BEFORE_INVALID') + 1_000,
    deadline: cleanupDeadline,
    now,
    sleep,
    pollMs,
  });

  let nextClaimNotBefore = now();
  while (now() < cleanupDeadline) {
    await waitUntil({ target: nextClaimNotBefore, deadline: cleanupDeadline, now, sleep, pollMs });
    const workerId = uuid(randomUUID(), 'CLEANUP_WORKER_ID_INVALID');
    const claim = parseCleanupClaim(
      await rpcData(admin, 'claim_account_storage_cleanup', {
        p_worker_id: workerId,
        p_limit: 1,
      }, requestGuard, cleanupDeadline),
      userId,
      tombstoneId,
    );
    if (claim === null) {
      nextClaimNotBefore = now() + pollMs;
      continue;
    }

    state = claim.state;
    onState(state);
    if (state === 'storage_cleared') {
      const purged = await rpcData(
        admin,
        'purge_user_account',
        { p_target_id: userId },
        requestGuard,
        cleanupDeadline,
      );
      const purgeConfirmed =
        isRecord(purged) &&
        purged.userId === userId &&
        purged.postPurgeCleanupPending === true &&
        (purged.deleted === true || (purged.deleted === false && purged.alreadyAbsent === true));
      if (!purgeConfirmed) fail('CLEANUP_AUTH_PURGE_CONTRACT_INVALID');
      state = 'post_purge_cleanup';
      onState(state);
      nextClaimNotBefore = now() + postPurgeDelayMs + 1_000;
      continue;
    }

    const objects = await listStoragePrefix(admin, userId, requestGuard, cleanupDeadline);
    await removeStorageObjects(admin, objects, requestGuard, cleanupDeadline);
    const remaining = await listStoragePrefix(admin, userId, requestGuard, cleanupDeadline);
    const outcome = remaining.length === 0 ? 'empty' : 'nonempty';
    const advanced = parseCleanupAdvance(
      await rpcData(admin, 'advance_account_storage_cleanup', {
        p_tombstone_id: tombstoneId,
        p_worker_id: workerId,
        p_outcome: outcome,
        p_error_code: remaining.length === 0 ? null : 'HOSTED_GATE_PREFIX_NOT_EMPTY',
      }, requestGuard, cleanupDeadline),
      tombstoneId,
    );
    state = advanced.state;
    onState(state);
    if (state === 'db_purged') return Object.freeze({ state, terminal: true });

    if (state === 'storage_cleared') {
      const purged = await rpcData(
        admin,
        'purge_user_account',
        { p_target_id: userId },
        requestGuard,
        cleanupDeadline,
      );
      const purgeConfirmed =
        isRecord(purged) &&
        purged.userId === userId &&
        purged.postPurgeCleanupPending === true &&
        (purged.deleted === true || (purged.deleted === false && purged.alreadyAbsent === true));
      if (!purgeConfirmed) fail('CLEANUP_AUTH_PURGE_CONTRACT_INVALID');
      state = 'post_purge_cleanup';
      onState(state);
      nextClaimNotBefore = now() + postPurgeDelayMs + 1_000;
      continue;
    }

    nextClaimNotBefore = advanced.nextAttemptAt
      ? serverTimestamp(advanced.nextAttemptAt, 'CLEANUP_NEXT_ATTEMPT_INVALID') + 1_000
      : now() + pollMs;
  }

  fail('CLEANUP_DEADLINE_EXCEEDED');
}

async function makeAvatarFixture() {
  return sharp({
    create: {
      width: 360,
      height: 360,
      channels: 3,
      background: { r: 29, g: 78, b: 216 },
    },
  })
    .webp({ quality: 82 })
    .toBuffer();
}

async function reconcileAmbiguousIdentity({
  admin,
  email,
  runToken,
  notBefore,
  request,
  deadline,
  now,
  sleep,
  pollMs,
}) {
  await waitUntil({ target: notBefore, deadline, now, sleep, pollMs });
  const matches = new Map();
  let inspected = 0;

  for (let page = 1; inspected < CREATE_RECONCILE_MAX_USERS; page += 1) {
    let result;
    try {
      result = await request.call(
        () => admin.auth.admin.listUsers({ page, perPage: CREATE_RECONCILE_PAGE_SIZE }),
        'TEST_IDENTITY_RECONCILIATION',
        deadline,
      );
    } catch (error) {
      rethrowOrFail(error, 'TEST_IDENTITY_RECONCILIATION_UNAVAILABLE');
    }
    if (result?.error || !Array.isArray(result?.data?.users)) {
      fail('TEST_IDENTITY_RECONCILIATION_FAILED');
    }
    const total = result.data.total;
    if (!Number.isSafeInteger(total) || total < 0 || total > CREATE_RECONCILE_MAX_USERS) {
      fail('TEST_IDENTITY_RECONCILIATION_COUNT_INVALID');
    }
    for (const user of result.data.users) {
      inspected += 1;
      if (
        isRecord(user) &&
        user.email === email &&
        user.user_metadata?.safetyhubHostedSecurityGate === true &&
        user.user_metadata?.safetyhubHostedSecurityGateRun === runToken
      ) {
        const candidateId = uuid(user.id, 'TEST_IDENTITY_RECONCILIATION_ID_INVALID');
        matches.set(candidateId, user);
      }
    }
    if (result.data.users.length < CREATE_RECONCILE_PAGE_SIZE || inspected >= total) break;
  }

  if (matches.size > 1) fail('TEST_IDENTITY_RECONCILIATION_NOT_UNIQUE');
  return matches.size === 1 ? matches.keys().next().value : null;
}

function probePrefix(objectKey) {
  const separator = objectKey.indexOf('/');
  if (separator < 1) fail('CLEANUP_PROBE_KEY_INVALID');
  return uuid(objectKey.slice(0, separator), 'CLEANUP_PROBE_KEY_INVALID');
}

async function cleanupForeignProbeKeys({ admin, userId, probeKeys, request, deadline }) {
  const foreignKeys = [...probeKeys].filter((key) => probePrefix(key) !== userId);
  if (foreignKeys.length === 0) return;
  const present = [];
  for (const key of foreignKeys) {
    let result;
    try {
      result = await request.call(
        () => admin.storage.from(AVATAR_BUCKET).download(key, {}, { cache: 'no-store' }),
        'FOREIGN_PROBE_INVENTORY',
        deadline,
      );
    } catch (error) {
      rethrowOrFail(error, 'FOREIGN_PROBE_INVENTORY_UNAVAILABLE');
    }
    const status = statusFromError(result?.error);
    if (!result?.error && result?.data) present.push(key);
    else if (!result?.error || !STORAGE_MISSING_STATUSES.has(status)) {
      fail('FOREIGN_PROBE_INVENTORY_UNTRUSTWORTHY');
    }
  }
  await removeStorageObjects(admin, present, request, deadline);
  for (const key of foreignKeys) {
    await assertObjectMissing(admin, key, 'FOREIGN_PROBE_OBJECT_SURVIVED', request, deadline);
  }
  for (const prefix of new Set(foreignKeys.map(probePrefix))) {
    if ((await listStoragePrefix(admin, prefix, request, deadline)).length !== 0) {
      fail('FOREIGN_PROBE_PREFIX_NOT_EMPTY');
    }
  }
}

async function verifyProbeKeysAbsent({ admin, userId, probeKeys, request, deadline }) {
  for (const key of probeKeys) {
    await assertObjectMissing(admin, key, 'PROBE_OBJECT_SURVIVED_CLEANUP', request, deadline);
  }
  for (const prefix of new Set([...probeKeys].map(probePrefix).filter((value) => value !== userId))) {
    if ((await listStoragePrefix(admin, prefix, request, deadline)).length !== 0) {
      fail('PROBE_PREFIX_NOT_EMPTY_AFTER_CLEANUP');
    }
  }
}

async function finishAbandonedAvatar({
  admin,
  userId,
  operation,
  storageWriteState,
  request,
  deadline,
}) {
  if (!operation) return;
  if (storageWriteState !== 'ambiguous') {
    try {
      await rpcData(
        admin,
        'finish_profile_avatar_storage_write',
        {
          p_user_id: userId,
          p_operation_token: operation.operationToken,
          p_error_code: 'HOSTED_GATE_ABORTED',
        },
        request,
        deadline,
      );
    } catch {
      // The durable write lease still expires on its own. Account cleanup
      // remains fail-closed until that lease can no longer admit a late write.
    }
  }
  try {
    await rpcData(
      admin,
      'abort_profile_avatar_upload',
      {
        p_user_id: userId,
        p_operation_token: operation.operationToken,
        p_error_code: 'HOSTED_GATE_ABORTED',
      },
      request,
      deadline,
    );
  } catch {
    // Account purge also requests cancellation. Its bounded state machine is
    // the final authority and must still reach db_purged. An ambiguous upload
    // deliberately retains the full write lease rather than clearing it here.
  }
}

function blankReport() {
  return {
    ok: false,
    targetRefSuffix: null,
    gates: {
      target: false,
      managementMarker: false,
      cleanBaseline: false,
      postgrestAcl: false,
      hostedStorage: false,
    },
    evidence: {
      postgrestDenials: 0,
      storagePositiveUploads: 0,
      storageNegativeUploads: 0,
      storageDeniedReads: 0,
      storageDeniedMutations: 0,
    },
    cleanup: {
      required: false,
      terminal: true,
      state: 'not_required',
      code: null,
    },
    failureCode: null,
  };
}

export async function runHostedSecurityGates({
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClient = createSupabaseClient,
  avatarFactory = makeAvatarFixture,
  now = Date.now,
  sleep,
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes,
  shouldStop = () => false,
} = {}) {
  const report = blankReport();
  let primaryCode = null;
  let admin;
  let userId;
  let avatarOperation;
  let storageWriteState = 'not_started';
  let config;
  let request;
  let runDeadline = Number.POSITIVE_INFINITY;
  let cleanupDeadline = Number.POSITIVE_INFINITY;
  let runToken;
  let email;
  const probeKeys = new Set();
  const sleepImpl =
    sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));

  try {
    config = resolveHostedGateConfig(env);
    runDeadline = now() + config.cleanupTimeoutMs;
    cleanupDeadline = runDeadline;
    request = createRequestGuard({
      requestTimeoutMs: config.requestTimeoutMs,
      now,
      getDeadline: () => cleanupDeadline,
    });
    report.targetRefSuffix = config.projectRef.slice(-6);
    report.gates.target = true;
    if (shouldStop()) fail('INTERRUPTED_BEFORE_REMOTE_PREFLIGHT');

    try {
      await request.call(
        () =>
          assertDisposableProjectMarker({
            projectRef: config.projectRef,
            accessToken: config.managementToken,
            fetchImpl: (input, init) =>
              request.fetch(fetchImpl, input, init, 'MANAGEMENT_MARKER', runDeadline),
          }),
        'MANAGEMENT_MARKER_VERIFICATION',
        runDeadline,
      );
    } catch {
      fail('MANAGEMENT_MARKER_VERIFICATION_FAILED');
    }
    report.gates.managementMarker = true;

    const boundedSupabaseFetch = (input, init) =>
      request.fetch(fetchImpl, input, init, 'SUPABASE_REQUEST', cleanupDeadline);
    admin = createClient(config.url, config.secretKey, supabaseOptions(boundedSupabaseFetch));
    try {
      await assertCleanLoadTestBaseline(admin, {
        call: (operation, code) => request.call(operation, code, runDeadline),
      });
    } catch {
      fail('CLEAN_DATA_BASELINE_REQUIRED');
    }
    await assertCleanStorageBaseline(admin, request, runDeadline);
    report.gates.cleanBaseline = true;
    if (shouldStop()) fail('INTERRUPTED_BEFORE_TEST_IDENTITY');

    runToken = randomBytes(12).toString('hex');
    email = `safetyhub-hosted-gate-${runToken}@example.test`;
    const password = `Shg-${randomBytes(24).toString('base64url')}!Aa1`;
    report.cleanup = {
      required: true,
      terminal: false,
      state: 'identity_create_unconfirmed',
      code: null,
    };
    let created;
    let createAmbiguous = false;
    const createStartedAt = now();
    try {
      created = await request.call(
        () =>
          admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
              name: 'Hosted',
              surname: 'SecurityGate',
              job: 'DisposableTest',
              safetyhubHostedSecurityGate: true,
              safetyhubHostedSecurityGateRun: runToken,
            },
          }),
        'TEST_IDENTITY_CREATE',
        runDeadline,
      );
      if (created?.error || !UUID_PATTERN.test(created?.data?.user?.id ?? '')) {
        createAmbiguous = true;
      }
    } catch {
      createAmbiguous = true;
    }
    if (createAmbiguous) {
      userId = await reconcileAmbiguousIdentity({
        admin,
        email,
        runToken,
        notBefore: createStartedAt + config.requestTimeoutMs + 1_000,
        request,
        deadline: runDeadline,
        now,
        sleep: sleepImpl,
        pollMs: config.cleanupPollMs,
      });
      if (userId === null) fail('TEST_IDENTITY_CREATE_UNCONFIRMED');
      report.cleanup.state = 'identity_reconciled';
      primaryCode = 'TEST_IDENTITY_CREATE_AMBIGUOUS';
      report.failureCode = primaryCode;
      fail(primaryCode);
    }
    userId = uuid(created?.data?.user?.id, 'TEST_IDENTITY_CREATE_CONTRACT_INVALID');
    report.cleanup.state = 'identity_created';

    const authenticated = createClient(
      config.url,
      config.publishableKey,
      supabaseOptions(boundedSupabaseFetch),
    );
    const anonymous = createClient(
      config.url,
      config.publishableKey,
      supabaseOptions(boundedSupabaseFetch),
    );
    let signedIn;
    try {
      signedIn = await request.call(
        () => authenticated.auth.signInWithPassword({ email, password }),
        'TEST_IDENTITY_SIGN_IN',
        runDeadline,
      );
    } catch (error) {
      rethrowOrFail(error, 'TEST_IDENTITY_SIGN_IN_UNAVAILABLE');
    }
    if (
      signedIn?.error ||
      signedIn?.data?.user?.id !== userId ||
      typeof signedIn?.data?.session?.access_token !== 'string' ||
      signedIn.data.session.access_token.length === 0
    ) {
      fail('TEST_IDENTITY_SIGN_IN_FAILED');
    }

    await assertServiceRpcPresence({
      admin,
      userId,
      randomUUID,
      request,
      deadline: runDeadline,
    });

    const acl = await runPostgrestAclGates({
      fetchImpl,
      url: config.url,
      publishableKey: config.publishableKey,
      accessToken: signedIn.data.session.access_token,
      userId,
      randomUUID,
      request,
      deadline: runDeadline,
    });
    report.gates.postgrestAcl = true;
    report.evidence.postgrestDenials = acl.denialProbes;
    if (shouldStop()) fail('INTERRUPTED_BEFORE_STORAGE_GATES');

    const storage = await runHostedStorageGates({
      admin,
      authenticated,
      anonymous,
      fetchImpl,
      url: config.url,
      userId,
      avatarBytes: await avatarFactory(),
      randomUUID,
      onOperation(operation) {
        avatarOperation = operation;
      },
      onStorageWriteState(state) {
        storageWriteState = state;
      },
      onProbeKey(key) {
        probeKeys.add(key);
      },
      request,
      deadline: runDeadline,
    });
    report.gates.hostedStorage = true;
    report.evidence.storagePositiveUploads = storage.positiveUploads;
    report.evidence.storageNegativeUploads = storage.negativeUploads;
    report.evidence.storageDeniedReads = storage.deniedReads;
    report.evidence.storageDeniedMutations = storage.deniedMutations;
    avatarOperation = undefined;
  } catch (error) {
    primaryCode = safeErrorCode(error);
    report.failureCode = primaryCode;
  } finally {
    if (admin && userId) {
      cleanupDeadline = now() + (config?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
      await finishAbandonedAvatar({
        admin,
        userId,
        operation: avatarOperation,
        storageWriteState,
        request,
        deadline: cleanupDeadline,
      });
      let cleanupCode = null;
      try {
        await cleanupForeignProbeKeys({
          admin,
          userId,
          probeKeys,
          request,
          deadline: cleanupDeadline,
        });
      } catch (error) {
        cleanupCode = safeErrorCode(error, 'FOREIGN_PROBE_CLEANUP_UNEXPECTED_FAILURE');
      }
      let cleaned;
      try {
        cleaned = await runOfficialAccountPurge({
          admin,
          userId,
          timeoutMs: config?.cleanupTimeoutMs,
          pollMs: config?.cleanupPollMs,
          now,
          sleep: sleepImpl,
          randomUUID,
          request,
          deadline: cleanupDeadline,
          onState(state) {
            report.cleanup.state = state;
          },
        });
      } catch (error) {
        cleanupCode ??= safeErrorCode(error, 'CLEANUP_UNEXPECTED_FAILURE');
      }
      if (cleaned?.terminal) {
        try {
          await verifyProbeKeysAbsent({
            admin,
            userId,
            probeKeys,
            request,
            deadline: cleanupDeadline,
          });
        } catch (error) {
          cleanupCode ??= safeErrorCode(error, 'PROBE_VERIFICATION_UNEXPECTED_FAILURE');
        }
      }
      if (cleaned?.terminal && cleanupCode === null) {
        report.cleanup = {
          required: true,
          terminal: cleaned.terminal,
          state: cleaned.state,
          code: null,
        };
      } else {
        report.cleanup.terminal = false;
        report.cleanup.code = cleanupCode ?? 'CLEANUP_INCOMPLETE';
      }
    }
  }

  if (primaryCode || !report.cleanup.terminal) {
    const code = primaryCode ?? report.cleanup.code ?? 'CLEANUP_INCOMPLETE';
    throw new HostedSecurityGateRunError(code, report);
  }
  report.ok = true;
  return report;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const signalState = { requested: false };
  const requestStop = () => {
    signalState.requested = true;
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  try {
    const report = await runHostedSecurityGates({
      shouldStop: () => signalState.requested,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const report = error instanceof HostedSecurityGateRunError ? error.report : blankReport();
    if (!(error instanceof HostedSecurityGateRunError)) {
      report.failureCode = safeErrorCode(error);
    }
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
