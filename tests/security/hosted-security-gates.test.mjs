import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  HostedSecurityGateError,
  HostedSecurityGateRunError,
  assertPostgrestDenied,
  assertStorageDenied,
  createRequestGuard,
  parsePreparedAvatarOperation,
  resolveHostedGateConfig,
  runHostedSecurityGates,
  runHostedStorageGates,
  runOfficialAccountPurge,
  runPostgrestAclGates,
} from '../../scripts/hosted-security-gates.mjs';
import {
  DISPOSABLE_PROJECT_MARKER,
  PRODUCTION_PROJECT_REF,
} from '../../scripts/load-test-safety.mjs';

const DISPOSABLE_REF = 'abcdefghijklmnopqrst';
const DISPOSABLE_URL = `https://${DISPOSABLE_REF}.supabase.co`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOMBSTONE_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '44444444-4444-4444-8444-444444444444';

function hostedEnv(overrides = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: DISPOSABLE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-test-value',
    SUPABASE_SECRET_KEY: 'secret-test-value',
    SUPABASE_ACCESS_TOKEN: 'management-test-value',
    SAFETYHUB_LOAD_TEST_PROJECT_REF: DISPOSABLE_REF,
    SAFETYHUB_LOAD_TEST_CONFIRM: DISPOSABLE_REF,
    SAFETYHUB_LOAD_TEST_MARKER: DISPOSABLE_PROJECT_MARKER,
    ...overrides,
  };
}

test('hosted config requires an exact disposable ref, confirmation, and high-friction marker', () => {
  const config = resolveHostedGateConfig(hostedEnv());
  assert.equal(config.projectRef, DISPOSABLE_REF);
  assert.equal(config.url, DISPOSABLE_URL);

  for (const overrides of [
    { SAFETYHUB_LOAD_TEST_PROJECT_REF: '' },
    { SAFETYHUB_LOAD_TEST_PROJECT_REF: ` ${DISPOSABLE_REF}` },
    { SAFETYHUB_LOAD_TEST_CONFIRM: `${DISPOSABLE_REF} ` },
    { SAFETYHUB_LOAD_TEST_MARKER: DISPOSABLE_PROJECT_MARKER.toLowerCase() },
    { SAFETYHUB_LOAD_TEST_MARKER: ` ${DISPOSABLE_PROJECT_MARKER}` },
  ]) {
    assert.throws(
      () => resolveHostedGateConfig(hostedEnv(overrides)),
      (error) =>
        error instanceof HostedSecurityGateError &&
        ['TARGET_PREFLIGHT_REFUSED', 'MISSING_SAFETYHUB_LOAD_TEST_PROJECT_REF'].includes(
          error.code,
        ),
    );
  }
});

test('hosted config requires a strict bounded request timeout', () => {
  assert.equal(resolveHostedGateConfig(hostedEnv()).requestTimeoutMs, 15_000);
  assert.equal(
    resolveHostedGateConfig(
      hostedEnv({ SAFETYHUB_HOSTED_REQUEST_TIMEOUT_MS: '1000' }),
    ).requestTimeoutMs,
    1_000,
  );
  for (const value of ['0', '999', '30001', '1.5', 'not-a-number']) {
    assert.throws(
      () =>
        resolveHostedGateConfig(
          hostedEnv({ SAFETYHUB_HOSTED_REQUEST_TIMEOUT_MS: value }),
        ),
      /INVALID_SAFETYHUB_HOSTED_REQUEST_TIMEOUT_MS/u,
    );
  }
});

test('request guard bounds a hung Supabase operation and caps calls at cleanup deadline', async () => {
  let clock = 10_000;
  const guard = createRequestGuard({
    requestTimeoutMs: 5,
    now: () => clock,
    getDeadline: () => 10_100,
  });
  await assert.rejects(
    guard.call(() => new Promise(() => undefined), 'HUNG_SUPABASE_CALL'),
    /HUNG_SUPABASE_CALL_TIMEOUT/u,
  );
  clock = 10_100;
  await assert.rejects(
    guard.call(async () => 'must not start', 'AFTER_CLEANUP_DEADLINE'),
    /REQUEST_DEADLINE_EXCEEDED/u,
  );
});

test('hosted config hard-denies production in the URL, explicit ref, and confirmation', () => {
  const productionUrl = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
  for (const overrides of [
    { NEXT_PUBLIC_SUPABASE_URL: productionUrl },
    {
      SAFETYHUB_LOAD_TEST_PROJECT_REF: PRODUCTION_PROJECT_REF,
      SAFETYHUB_LOAD_TEST_CONFIRM: PRODUCTION_PROJECT_REF,
    },
    { SAFETYHUB_LOAD_TEST_CONFIRM: PRODUCTION_PROJECT_REF },
    {
      NEXT_PUBLIC_SUPABASE_URL: productionUrl,
      SAFETYHUB_LOAD_TEST_PROJECT_REF: PRODUCTION_PROJECT_REF,
      SAFETYHUB_LOAD_TEST_CONFIRM: PRODUCTION_PROJECT_REF,
    },
  ]) {
    assert.throws(
      () => resolveHostedGateConfig(hostedEnv(overrides)),
      (error) => error instanceof HostedSecurityGateError && error.code === 'TARGET_PREFLIGHT_REFUSED',
    );
  }
});

test('denial helpers accept provider ACL statuses but reject success and transport-shaped errors', () => {
  for (const status of [400, 401, 403, 404, 409]) {
    assert.equal(assertStorageDenied({ error: { statusCode: String(status) } }), status);
  }
  for (const status of [401, 403, 404, 406]) {
    assert.equal(assertPostgrestDenied({ status }), status);
  }

  assert.throws(() => assertStorageDenied({ data: null, error: null }), /STORAGE_OPERATION_NOT_DENIED/u);
  assert.throws(
    () => assertStorageDenied({ error: new Error('network') }),
    /STORAGE_OPERATION_NOT_DENIED/u,
  );
  assert.throws(
    () =>
      assertStorageDenied({
        error: {
          status: 500,
          name: 'StorageApiError',
          statusCode: 'DatabaseError',
          message: 'generic database outage',
        },
      }),
    /STORAGE_OPERATION_NOT_DENIED/u,
  );
  assert.equal(
    assertStorageDenied({
      error: {
        status: 500,
        name: 'StorageApiError',
        statusCode: 'DatabaseError',
        message: 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED',
      },
    }),
    500,
  );
  assert.throws(() => assertPostgrestDenied({ status: 200 }), /POSTGREST_OPERATION_NOT_DENIED/u);
  assert.throws(() => assertPostgrestDenied({ status: 500 }), /POSTGREST_OPERATION_NOT_DENIED/u);
});

test('prepared avatar contract binds one exact user, operation token, and immutable key', () => {
  assert.deepEqual(
    parsePreparedAvatarOperation(
      {
        status: 'prepared',
        operationToken: OPERATION_ID,
        objectKey: `${USER_ID}/objects/${OPERATION_ID}.webp`,
      },
      USER_ID,
    ),
    {
      operationToken: OPERATION_ID,
      objectKey: `${USER_ID}/objects/${OPERATION_ID}.webp`,
    },
  );

  for (const value of [
    null,
    {
      status: 'staged',
      operationToken: OPERATION_ID,
      objectKey: `${USER_ID}/objects/${OPERATION_ID}.webp`,
    },
    {
      status: 'prepared',
      operationToken: OPERATION_ID,
      objectKey: `${USER_ID}/avatar.webp`,
    },
    {
      status: 'prepared',
      operationToken: 'not-a-uuid',
      objectKey: `${USER_ID}/objects/not-a-uuid.webp`,
    },
  ]) {
    assert.throws(() => parsePreparedAvatarOperation(value, USER_ID), /AVATAR_/u);
  }
});

test('PostgREST ACL gates probe private schema and service RPCs as anon and authenticated', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { status: url.includes('avatar_upload_operations') ? 406 : 403 };
  };

  const result = await runPostgrestAclGates({
    fetchImpl,
    url: DISPOSABLE_URL,
    publishableKey: 'publishable-test-value',
    accessToken: 'disposable-user-access-token',
    userId: USER_ID,
    randomUUID: () => WORKER_ID,
  });

  assert.deepEqual(result, { denialProbes: 6 });
  assert.equal(requests.length, 6);
  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    [
      '/rest/v1/avatar_upload_operations',
      '/rest/v1/avatar_upload_operations',
      '/rest/v1/rpc/claim_account_storage_cleanup',
      '/rest/v1/rpc/claim_account_storage_cleanup',
      '/rest/v1/rpc/consume_business_quota_for_actor',
      '/rest/v1/rpc/begin_user_account_purge',
    ],
  );
  assert.equal(requests[0].init.headers['accept-profile'], 'private');
  assert.equal(requests[1].init.headers['accept-profile'], 'private');
  assert.equal(requests[0].init.headers.authorization, 'Bearer publishable-test-value');
  assert.equal(requests[1].init.headers.authorization, 'Bearer disposable-user-access-token');
  assert.equal(requests[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[4].init.body), {
    p_actor_id: USER_ID,
    p_action: 'avatar.upload',
  });
  assert.deepEqual(JSON.parse(requests[5].init.body), { p_target_id: USER_ID });
});

test('a successful PostgREST service RPC response fails the ACL gate closed', async () => {
  let request = 0;
  await assert.rejects(
    runPostgrestAclGates({
      fetchImpl: async () => {
        request += 1;
        return { status: request === 4 ? 200 : 403 };
      },
      url: DISPOSABLE_URL,
      publishableKey: 'publishable-test-value',
      accessToken: 'disposable-user-access-token',
      userId: USER_ID,
      randomUUID: () => WORKER_ID,
    }),
    /AUTH_SERVICE_RPC_EXPOSED/u,
  );
});

test('hosted Storage gates enforce the exact begin/upload/finish/stage/finalize contract', async () => {
  const avatarBytes = Buffer.from('hosted-storage-gate-fixture');
  const sha256 = crypto.createHash('sha256').update(avatarBytes).digest('hex');
  const foreignUserId = '55555555-5555-4555-8555-555555555555';
  const foreignToken = '66666666-6666-4666-8666-666666666666';
  const wrongToken = '77777777-7777-4777-8777-777777777777';
  const randomValues = [foreignUserId, foreignToken, wrongToken];
  const objectKey = `${USER_ID}/objects/${OPERATION_ID}.webp`;
  const objects = new Map();
  const rpcCalls = [];
  const operationCallbacks = [];
  let committed = false;

  const manifest = () => ({
    objectKey,
    sha256,
    bytes: avatarBytes.byteLength,
    legacyImported: false,
    updatedAt: '2026-08-14T00:00:00.000Z',
  });
  const operation = (status) => ({
    status,
    operationToken: OPERATION_ID,
    objectKey,
  });
  const adminBucket = {
    async download(key) {
      if (!objects.has(key)) return { data: null, error: { statusCode: '404' } };
      return { data: new Blob([objects.get(key)]), error: null };
    },
    async createSignedUrl(key, expiresIn) {
      assert.equal(key, objectKey);
      assert.equal(expiresIn, 600);
      return {
        data: {
          signedUrl: `${DISPOSABLE_URL}/storage/v1/object/sign/profile-avatars/${key}?token=test`,
        },
        error: null,
      };
    },
  };
  const admin = {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === 'begin_profile_avatar_upload') return { data: operation('prepared'), error: null };
      if (name === 'finish_profile_avatar_storage_write') {
        return { data: operation('prepared'), error: null };
      }
      if (name === 'mark_profile_avatar_staged') return { data: operation('staged'), error: null };
      if (name === 'finalize_profile_avatar_upload') {
        committed = true;
        return { data: operation('committed'), error: null };
      }
      if (name === 'get_profile_avatar_manifest') return { data: manifest(), error: null };
      throw new Error(`unexpected admin RPC ${name}`);
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'profile-avatars');
        return adminBucket;
      },
    },
  };
  const authenticatedBucket = {
    async upload(key, bytes, options) {
      if (key === objectKey && options.upsert === false && !objects.has(key)) {
        objects.set(key, Buffer.from(bytes));
        return { data: { path: key }, error: null };
      }
      return { data: null, error: { statusCode: options.upsert ? '409' : '403' } };
    },
    async download(key) {
      if (!committed || !objects.has(key)) return { data: null, error: { statusCode: '403' } };
      return { data: new Blob([objects.get(key)]), error: null };
    },
    async remove() {
      return { data: null, error: { statusCode: '403' } };
    },
  };
  const authenticated = {
    async rpc(name) {
      assert.equal(name, 'get_my_profile_avatar_manifest');
      return { data: committed ? manifest() : null, error: null };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'profile-avatars');
        return authenticatedBucket;
      },
    },
  };
  const anonymous = {
    storage: {
      from(bucket) {
        assert.equal(bucket, 'profile-avatars');
        return {
          async upload() {
            return { data: null, error: { statusCode: '403' } };
          },
          async download() {
            return { data: null, error: { statusCode: '403' } };
          },
        };
      },
    },
  };

  const result = await runHostedStorageGates({
    admin,
    authenticated,
    anonymous,
    fetchImpl: async () => new Response(avatarBytes, { status: 200 }),
    url: DISPOSABLE_URL,
    userId: USER_ID,
    avatarBytes,
    randomUUID: () => randomValues.shift(),
    onOperation: (value) => operationCallbacks.push(value),
  });

  assert.deepEqual(result, {
    positiveUploads: 1,
    negativeUploads: 4,
    deniedReads: 2,
    deniedMutations: 2,
  });
  assert.deepEqual(
    rpcCalls.map(({ name }) => name),
    [
      'begin_profile_avatar_upload',
      'finish_profile_avatar_storage_write',
      'mark_profile_avatar_staged',
      'finalize_profile_avatar_upload',
      'get_profile_avatar_manifest',
    ],
  );
  assert.deepEqual(operationCallbacks, [
    { operationToken: OPERATION_ID, objectKey },
    undefined,
  ]);
  assert.deepEqual(objects.get(objectKey), avatarBytes);
});

test('ambiguous authorized upload preserves its write lease and still reaches official cleanup', async () => {
  const avatarBytes = Buffer.from('ambiguous-write');
  const foreignUserId = '55555555-5555-4555-8555-555555555555';
  const foreignToken = '66666666-6666-4666-8666-666666666666';
  const wrongToken = '77777777-7777-4777-8777-777777777777';
  const randomValues = [foreignUserId, foreignToken, wrongToken];
  const objectKey = `${USER_ID}/objects/${OPERATION_ID}.webp`;
  const rpcNames = [];
  const operationCallbacks = [];
  const writeStates = [];
  const admin = {
    async rpc(name) {
      rpcNames.push(name);
      if (name === 'begin_profile_avatar_upload') {
        return {
          data: { status: 'prepared', operationToken: OPERATION_ID, objectKey },
          error: null,
        };
      }
      if (name === 'abort_profile_avatar_upload') {
        return {
          data: { status: 'cancel_requested', operationToken: OPERATION_ID, objectKey },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    storage: {
      from() {
        return {
          async download() {
            return { data: null, error: { statusCode: '404' } };
          },
        };
      },
    },
  };
  const authenticated = {
    async rpc() {
      return { data: null, error: null };
    },
    storage: {
      from() {
        return {
          async upload(key) {
            if (key === objectKey) return new Promise(() => undefined);
            return { data: null, error: { statusCode: '403' } };
          },
        };
      },
    },
  };
  const anonymous = {
    storage: {
      from() {
        return {
          async upload() {
            return { data: null, error: { statusCode: '403' } };
          },
        };
      },
    },
  };
  const request = createRequestGuard({ requestTimeoutMs: 5 });

  await assert.rejects(
    runHostedStorageGates({
      admin,
      authenticated,
      anonymous,
      url: DISPOSABLE_URL,
      userId: USER_ID,
      avatarBytes,
      randomUUID: () => randomValues.shift(),
      onOperation: (value) => operationCallbacks.push(value),
      onStorageWriteState: (value) => writeStates.push(value),
      request,
    }),
    /AUTHENTICATED_IMMUTABLE_UPLOAD_TIMEOUT/u,
  );
  assert.deepEqual(writeStates, ['ambiguous', 'not_started', 'ambiguous']);
  assert.deepEqual(operationCallbacks, [{ operationToken: OPERATION_ID, objectKey }]);

  // The source-level cleanup contract must keep ambiguous writes away from
  // finish_profile_avatar_storage_write, which would clear the 30-minute lease.
  const source = await readFile(
    new URL('../../scripts/hosted-security-gates.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /if \(storageWriteState !== 'ambiguous'\) \{[\s\S]*finish_profile_avatar_storage_write[\s\S]*\}\s*try \{[\s\S]*abort_profile_avatar_upload/u,
  );
});

test('every foreign negative probe key is tracked for exact privileged cleanup', async () => {
  const avatarBytes = Buffer.from('foreign-probe');
  const foreignUserId = '55555555-5555-4555-8555-555555555555';
  const foreignToken = '66666666-6666-4666-8666-666666666666';
  const wrongToken = '77777777-7777-4777-8777-777777777777';
  const foreignKey = `${foreignUserId}/objects/${foreignToken}.webp`;
  const randomValues = [foreignUserId, foreignToken, wrongToken];
  const tracked = [];
  const authenticated = {
    async rpc() {
      return { data: null, error: null };
    },
    storage: {
      from() {
        return {
          async upload(key) {
            if (key === foreignKey) return { data: { path: key }, error: null };
            return { data: null, error: { statusCode: '403' } };
          },
        };
      },
    },
  };
  const admin = {
    storage: {
      from() {
        return {
          async download() {
            return { data: null, error: { statusCode: '404' } };
          },
        };
      },
    },
  };

  await assert.rejects(
    runHostedStorageGates({
      admin,
      authenticated,
      anonymous: authenticated,
      url: DISPOSABLE_URL,
      userId: USER_ID,
      avatarBytes,
      randomUUID: () => randomValues.shift(),
      onProbeKey: (key) => tracked.push(key),
    }),
    /FOREIGN_PREFIX_UPLOAD_NOT_DENIED/u,
  );
  assert.deepEqual(tracked, [foreignKey]);

  const source = await readFile(
    new URL('../../scripts/hosted-security-gates.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /onProbeKey\(objectKey\);[\s\S]*client\.storage/u);
  assert.match(source, /cleanupForeignProbeKeys\(\{[\s\S]*probeKeys/u);
  assert.match(source, /removeStorageObjects\(admin, present, request, deadline\)/u);
  assert.match(source, /FOREIGN_PROBE_OBJECT_SURVIVED/u);
  assert.match(source, /FOREIGN_PROBE_PREFIX_NOT_EMPTY/u);
});

function purgeAdmin({ wrongClaim = false } = {}) {
  const calls = [];
  const claims = [
    { state: 'sweeping' },
    { state: 'empty_once' },
    { state: 'post_purge_cleanup' },
    { state: 'post_purge_empty_once' },
  ];
  const advances = [
    { state: 'empty_once' },
    { state: 'storage_cleared' },
    { state: 'post_purge_empty_once' },
    { state: 'db_purged' },
  ];
  let listCall = 0;

  return {
    calls,
    async rpc(name, args) {
      calls.push({ operation: 'rpc', name, args });
      if (name === 'begin_user_account_purge') {
        return {
          data: {
            userId: USER_ID,
            exists: true,
            pending: true,
            tombstoneId: TOMBSTONE_ID,
            state: 'cleanup_pending',
            cleanupNotBefore: '2023-11-14T22:13:19.000Z',
          },
          error: null,
        };
      }
      if (name === 'claim_account_storage_cleanup') {
        const claim = claims.shift();
        return {
          data: [
            {
              tombstoneId: wrongClaim ? OPERATION_ID : TOMBSTONE_ID,
              userId: USER_ID,
              storagePrefix: `${USER_ID}/`,
              ...claim,
            },
          ],
          error: null,
        };
      }
      if (name === 'advance_account_storage_cleanup') {
        const advance = advances.shift();
        return {
          data: {
            tombstoneId: TOMBSTONE_ID,
            nextAttemptAt: '2023-11-14T22:13:19.000Z',
            ...advance,
          },
          error: null,
        };
      }
      if (name === 'purge_user_account') {
        return {
          data: {
            deleted: true,
            userId: USER_ID,
            postPurgeCleanupPending: true,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'profile-avatars');
        return {
          async list(folder, options) {
            calls.push({ operation: 'list', folder, options });
            listCall += 1;
            return {
              data:
                listCall % 2 === 1
                  ? [{ id: `object-${listCall}`, name: 'avatar.webp', metadata: {} }]
                  : [],
              error: null,
            };
          },
          async remove(objects) {
            calls.push({ operation: 'remove', objects });
            return { data: objects, error: null };
          },
        };
      },
    },
  };
}

test('cleanup reaches db_purged only through the official claim/remove/advance/purge state machine', async () => {
  const admin = purgeAdmin();
  let clock = 1_700_000_000_000;
  const states = [];
  const result = await runOfficialAccountPurge({
    admin,
    userId: USER_ID,
    timeoutMs: 60_000,
    pollMs: 1_000,
    postPurgeDelayMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    randomUUID: () => WORKER_ID,
    onState: (state) => states.push(state),
  });

  assert.deepEqual(result, { state: 'db_purged', terminal: true });
  assert.deepEqual(states, [
    'cleanup_pending',
    'sweeping',
    'empty_once',
    'empty_once',
    'storage_cleared',
    'post_purge_cleanup',
    'post_purge_cleanup',
    'post_purge_empty_once',
    'post_purge_empty_once',
    'db_purged',
  ]);
  assert.deepEqual(
    admin.calls.filter(({ operation }) => operation === 'rpc').map(({ name }) => name),
    [
      'begin_user_account_purge',
      'claim_account_storage_cleanup',
      'advance_account_storage_cleanup',
      'claim_account_storage_cleanup',
      'advance_account_storage_cleanup',
      'purge_user_account',
      'claim_account_storage_cleanup',
      'advance_account_storage_cleanup',
      'claim_account_storage_cleanup',
      'advance_account_storage_cleanup',
    ],
  );
  assert.equal(admin.calls.filter(({ operation }) => operation === 'remove').length, 4);
  assert.equal('auth' in admin, false);
});

test('cleanup refuses a claim for any other tombstone and never reaches Auth purge', async () => {
  const admin = purgeAdmin({ wrongClaim: true });
  let clock = 1_700_000_000_000;
  await assert.rejects(
    runOfficialAccountPurge({
      admin,
      userId: USER_ID,
      timeoutMs: 60_000,
      pollMs: 1_000,
      postPurgeDelayMs: 0,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      randomUUID: () => WORKER_ID,
    }),
    /CLEANUP_CLAIM_CONTRACT_INVALID/u,
  );
  assert.equal(
    admin.calls.some(({ name }) => name === 'purge_user_account'),
    false,
  );
});

test('a post-create gate failure still completes official cleanup and returns only redacted evidence', async () => {
  const admin = purgeAdmin();
  const cleanupStorage = admin.storage;
  admin.storage = {
    async getBucket(bucket) {
      assert.equal(bucket, 'profile-avatars');
      return { data: { id: bucket, name: bucket, public: false }, error: null };
    },
    from(bucket) {
      const cleanupBucket = cleanupStorage.from(bucket);
      return {
        ...cleanupBucket,
        async list(folder, options) {
          if (folder === '') return { data: [], error: null };
          return cleanupBucket.list(folder, options);
        },
      };
    },
  };
  admin.from = (table) => ({
    async select(columns, options) {
      admin.calls.push({ operation: 'baseline', table, columns, options });
      return { count: 0, error: null };
    },
  });
  admin.auth = {
    admin: {
      async listUsers(options) {
        admin.calls.push({ operation: 'listUsers', options });
        return { data: { users: [], total: 0 }, error: null };
      },
      async createUser() {
        admin.calls.push({ operation: 'createUser' });
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
  };

  let clientNumber = 0;
  const createClient = () => {
    clientNumber += 1;
    if (clientNumber === 1) return admin;
    return {
      auth: {
        async signInWithPassword() {
          return { data: { user: null, session: null }, error: { status: 400 } };
        },
      },
    };
  };
  let clock = 1_700_000_000_000;
  let thrown;
  try {
    await runHostedSecurityGates({
      env: hostedEnv(),
      fetchImpl: async (url) => {
        assert.equal(url, `https://api.supabase.com/v1/projects/${DISPOSABLE_REF}`);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: DISPOSABLE_REF,
              ref: DISPOSABLE_REF,
              name: DISPOSABLE_PROJECT_MARKER,
            };
          },
        };
      },
      createClient,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      randomUUID: () => WORKER_ID,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof HostedSecurityGateRunError);
  assert.equal(thrown.code, 'TEST_IDENTITY_SIGN_IN_FAILED');
  assert.equal(thrown.report.cleanup.terminal, true);
  assert.equal(thrown.report.cleanup.state, 'db_purged');
  assert.equal(thrown.report.gates.target, true);
  assert.equal(thrown.report.gates.managementMarker, true);
  assert.equal(thrown.report.gates.cleanBaseline, true);
  assert.equal(thrown.report.gates.postgrestAcl, false);
  const serialized = JSON.stringify(thrown.report);
  assert.doesNotMatch(serialized, /publishable-test-value/u);
  assert.doesNotMatch(serialized, /secret-test-value/u);
  assert.doesNotMatch(serialized, /management-test-value/u);
  assert.doesNotMatch(serialized, /safetyhub-hosted-gate-/u);
  assert.doesNotMatch(serialized, new RegExp(DISPOSABLE_REF, 'u'));
  assert.equal(
    admin.calls.filter(({ operation }) => operation === 'createUser').length,
    1,
  );
});

test('an ambiguous create result is reconciled by exact private marker and officially purged', async () => {
  const admin = purgeAdmin();
  const cleanupStorage = admin.storage;
  let createdEmail;
  let createdMetadata;
  let listUsersCalls = 0;
  admin.storage = {
    async getBucket() {
      return { data: { public: false }, error: null };
    },
    from(bucket) {
      const cleanupBucket = cleanupStorage.from(bucket);
      return {
        ...cleanupBucket,
        async list(folder, options) {
          if (folder === '') return { data: [], error: null };
          return cleanupBucket.list(folder, options);
        },
      };
    },
  };
  admin.from = () => ({
    async select() {
      return { count: 0, error: null };
    },
  });
  admin.auth = {
    admin: {
      async listUsers() {
        listUsersCalls += 1;
        if (listUsersCalls === 1) return { data: { users: [], total: 0 }, error: null };
        return {
          data: {
            users: [
              {
                id: USER_ID,
                email: createdEmail,
                user_metadata: createdMetadata,
              },
            ],
            total: 1,
          },
          error: null,
        };
      },
      async createUser(input) {
        createdEmail = input.email;
        createdMetadata = input.user_metadata;
        return { data: { user: null }, error: { status: 504 } };
      },
    },
  };

  let clock = 1_700_000_000_000;
  let thrown;
  try {
    await runHostedSecurityGates({
      env: hostedEnv({ SAFETYHUB_HOSTED_REQUEST_TIMEOUT_MS: '1000' }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { id: DISPOSABLE_REF, name: DISPOSABLE_PROJECT_MARKER };
        },
      }),
      createClient: () => admin,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      randomUUID: () => WORKER_ID,
      randomBytes: (size) => Buffer.alloc(size, 11),
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof HostedSecurityGateRunError);
  assert.equal(thrown.code, 'TEST_IDENTITY_CREATE_AMBIGUOUS');
  assert.equal(thrown.report.cleanup.terminal, true);
  assert.equal(thrown.report.cleanup.state, 'db_purged');
  assert.equal(listUsersCalls, 2);
  assert.equal(
    admin.calls.some(({ name }) => name === 'begin_user_account_purge'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(thrown.report), new RegExp(createdEmail, 'u'));
  assert.doesNotMatch(JSON.stringify(thrown.report), new RegExp(USER_ID, 'u'));
});

test('an unexpectedly accepted foreign-prefix probe is removed and verified before account purge', async () => {
  const admin = purgeAdmin();
  const baseRpc = admin.rpc.bind(admin);
  const baseStorage = admin.storage;
  const foreignUserId = '55555555-5555-4555-8555-555555555555';
  const foreignToken = '66666666-6666-4666-8666-666666666666';
  const wrongToken = '77777777-7777-4777-8777-777777777777';
  const absentUserId = '88888888-8888-4888-8888-888888888888';
  const foreignKey = `${foreignUserId}/objects/${foreignToken}.webp`;
  const objects = new Map();
  const removed = [];
  let deletionStarted = false;

  admin.rpc = async (name, args) => {
    if (name === 'consume_business_quota_for_actor') {
      return { data: { allowed: true, retryAfter: 0 }, error: null };
    }
    if (name === 'begin_user_account_purge' && args.p_target_id === absentUserId) {
      return {
        data: { userId: absentUserId, exists: false, pending: false },
        error: null,
      };
    }
    if (name === 'claim_account_storage_cleanup' && !deletionStarted) {
      return { data: [], error: null };
    }
    if (name === 'begin_user_account_purge' && args.p_target_id === USER_ID) {
      deletionStarted = true;
    }
    return baseRpc(name, args);
  };
  admin.storage = {
    async getBucket() {
      return { data: { public: false }, error: null };
    },
    from(bucket) {
      const cleanupBucket = baseStorage.from(bucket);
      return {
        async list(folder, options) {
          if (folder === '' || folder === foreignUserId) return { data: [], error: null };
          return cleanupBucket.list(folder, options);
        },
        async download(key) {
          if (objects.has(key)) return { data: new Blob([objects.get(key)]), error: null };
          return { data: null, error: { statusCode: '404' } };
        },
        async remove(keys) {
          if (keys.includes(foreignKey)) {
            removed.push(...keys);
            keys.forEach((key) => objects.delete(key));
            return { data: keys, error: null };
          }
          return cleanupBucket.remove(keys);
        },
      };
    },
  };
  admin.from = () => ({
    async select() {
      return { count: 0, error: null };
    },
  });
  admin.auth = {
    admin: {
      async listUsers() {
        return { data: { users: [], total: 0 }, error: null };
      },
      async createUser() {
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
  };

  const authenticated = {
    auth: {
      async signInWithPassword() {
        return {
          data: {
            user: { id: USER_ID },
            session: { access_token: 'disposable-user-access-token' },
          },
          error: null,
        };
      },
    },
    async rpc(name) {
      assert.equal(name, 'get_my_profile_avatar_manifest');
      return { data: null, error: null };
    },
    storage: {
      from() {
        return {
          async upload(key, bytes) {
            if (key === foreignKey) {
              objects.set(key, Buffer.from(bytes));
              return { data: { path: key }, error: null };
            }
            return { data: null, error: { statusCode: '403' } };
          },
        };
      },
    },
  };
  const anonymous = { storage: authenticated.storage };
  let clientNumber = 0;
  const createClient = () => {
    clientNumber += 1;
    if (clientNumber === 1) return admin;
    if (clientNumber === 2) return authenticated;
    return anonymous;
  };
  const randomValues = [WORKER_ID, absentUserId, WORKER_ID, foreignUserId, foreignToken, wrongToken];
  let clock = 1_700_000_000_000;
  let thrown;
  try {
    await runHostedSecurityGates({
      env: hostedEnv(),
      fetchImpl: async (url) => {
        if (String(url).startsWith('https://api.supabase.com/')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { id: DISPOSABLE_REF, name: DISPOSABLE_PROJECT_MARKER };
            },
          };
        }
        return { status: 403 };
      },
      createClient,
      avatarFactory: async () => Buffer.from('foreign-probe-body'),
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      randomUUID: () => randomValues.shift() ?? WORKER_ID,
      randomBytes: (size) => Buffer.alloc(size, 13),
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof HostedSecurityGateRunError);
  assert.equal(thrown.code, 'FOREIGN_PREFIX_UPLOAD_NOT_DENIED');
  assert.equal(thrown.report.cleanup.terminal, true);
  assert.equal(thrown.report.cleanup.state, 'db_purged');
  assert.deepEqual(removed, [foreignKey]);
  assert.equal(objects.has(foreignKey), false);
  assert.equal(
    admin.calls.some(({ name }) => name === 'begin_user_account_purge'),
    true,
  );
});

test('hosted harness orders all fail-closed preflights before its first write and logs only redacted report fields', async () => {
  const source = await readFile(
    new URL('../../scripts/hosted-security-gates.mjs', import.meta.url),
    'utf8',
  );

  const target = source.indexOf('config = resolveHostedGateConfig(env);');
  const runStart = source.indexOf('export async function runHostedSecurityGates');
  const marker = source.indexOf('assertDisposableProjectMarker({', runStart);
  const dataBaseline = source.indexOf('await assertCleanLoadTestBaseline(admin, {', runStart);
  const storageBaseline = source.indexOf('await assertCleanStorageBaseline(admin, request, runDeadline);', runStart);
  const firstWrite = source.indexOf('admin.auth.admin.createUser({', runStart);

  assert.ok(target >= 0);
  assert.ok(marker > target);
  assert.ok(dataBaseline > marker);
  assert.ok(storageBaseline > dataBaseline);
  assert.ok(firstWrite > storageBaseline);
  assert.match(source, /begin_profile_avatar_upload/u);
  assert.match(source, /upsert: false/u);
  assert.match(source, /finish_profile_avatar_storage_write/u);
  assert.match(source, /mark_profile_avatar_staged/u);
  assert.match(source, /finalize_profile_avatar_upload/u);
  assert.match(source, /upsert: true/u);
  assert.match(source, /begin_user_account_purge/u);
  assert.match(source, /claim_account_storage_cleanup/u);
  assert.match(source, /advance_account_storage_cleanup/u);
  assert.match(source, /purge_user_account/u);
  assert.match(source, /state === 'db_purged'/u);
  assert.doesNotMatch(source, /deleteUser/u);
  assert.doesNotMatch(source, /\.env\.local/u);
  assert.doesNotMatch(source, /error\.message/u);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)/u);
  assert.match(source, /targetRefSuffix: null/u);
  assert.match(source, /process\.exitCode = 1/u);
});
