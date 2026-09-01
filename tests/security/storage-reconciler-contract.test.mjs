import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function read(file) {
  return readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
}

const workerFile = 'supabase/functions/storage-reconciler/index.ts';
const migrationFile = 'supabase/migrations/20260813070000_persistent_actor_quota.sql';

async function loadWorkerHandler(env, createClient) {
  const source = await read(workerFile);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const importStatement = "import { createClient } from 'npm:@supabase/supabase-js@2.111.0';";
  assert.ok(transpiled.includes(importStatement));
  const executable = transpiled.replace(
    importStatement,
    'const createClient = globalThis.__storageReconcilerCreateClient;',
  );
  const previousDeno = globalThis.Deno;
  const previousCreateClient = globalThis.__storageReconcilerCreateClient;
  let handler;
  globalThis.__storageReconcilerCreateClient = createClient;
  globalThis.Deno = {
    env: { get: (name) => env[name] },
    serve: (candidate) => {
      handler = candidate;
    },
  };
  await import(
    `data:text/javascript;base64,${Buffer.from(`${executable}\n// ${crypto.randomUUID()}`).toString('base64')}`
  );
  assert.equal(typeof handler, 'function');
  return {
    handler,
    restore() {
      if (previousDeno === undefined) delete globalThis.Deno;
      else globalThis.Deno = previousDeno;
      if (previousCreateClient === undefined) {
        delete globalThis.__storageReconcilerCreateClient;
      } else {
        globalThis.__storageReconcilerCreateClient = previousCreateClient;
      }
    },
  };
}

test('storage reconciler is POST-only and authenticates before service-role use', async () => {
  const [worker, config, env] = await Promise.all([
    read(workerFile),
    read('supabase/config.toml'),
    read('.env.example'),
  ]);

  assert.match(config, /\[functions\.storage-reconciler\]\s+verify_jwt\s*=\s*false/u);
  assert.match(worker, /if \(request\.method !== 'POST'\)[\s\S]*status: 405/u);
  assert.match(worker, /requiredEnv\('STORAGE_RECONCILER_SECRET'\)/u);
  assert.match(worker, /secretLength < 32 \|\|\s+secretLength > MAX_BEARER_BYTES/u);
  assert.match(worker, /secret === EXAMPLE_RECONCILER_SECRET/u);
  assert.match(worker, /\^Bearer \(\[\^\\s,\]\+\)\$\/iu/u);
  assert.match(worker, /crypto\.subtle\.digest\('SHA-256'/u);
  assert.match(worker, /let mismatch = a\.length \^ b\.length;[\s\S]*mismatch \|=/u);
  assert.match(worker, /'cache-control': 'no-store'/u);
  assert.doesNotMatch(worker, /request\.(?:json|text|formData)\(/u);
  assert.ok(
    worker.indexOf("requiredEnv('STORAGE_RECONCILER_SECRET')") < worker.indexOf('createClient('),
  );
  assert.match(env, /Edge Function only:[\s\S]*STORAGE_RECONCILER_SECRET=/u);
  assert.doesNotMatch(env, /NEXT_PUBLIC_STORAGE_RECONCILER/u);
});

test('runtime boundary rejects unauthenticated calls before creating a service client', async () => {
  const secret = 'test-only-secret-material-'.repeat(2);
  const rpcCalls = [];
  let clientCreations = 0;
  const client = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === 'claim_stale_course_presentations') {
        return { data: { items: [] }, error: null };
      }
      if (name.startsWith('claim_')) return { data: [], error: null };
      return { data: { deleted: 0 }, error: null };
    },
  };
  const loaded = await loadWorkerHandler(
    {
      STORAGE_RECONCILER_SECRET: secret,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role-key',
    },
    () => {
      clientCreations += 1;
      return client;
    },
  );

  try {
    const methodResponse = await loaded.handler(
      new Request('https://example.test/reconcile', { method: 'GET' }),
    );
    assert.equal(methodResponse.status, 405);
    assert.equal(methodResponse.headers.get('cache-control'), 'no-store');

    const forbiddenResponse = await loaded.handler(
      new Request('https://example.test/reconcile', {
        method: 'POST',
        headers: { authorization: 'Bearer definitely-wrong' },
      }),
    );
    assert.equal(forbiddenResponse.status, 403);
    assert.equal(forbiddenResponse.headers.get('cache-control'), 'no-store');
    assert.equal(clientCreations, 0);
    assert.deepEqual(rpcCalls, []);

    const successResponse = await loaded.handler(
      new Request('https://example.test/reconcile', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    assert.equal(successResponse.status, 200);
    assert.equal(successResponse.headers.get('cache-control'), 'no-store');
    assert.equal(clientCreations, 1);
    assert.deepEqual(
      rpcCalls.map(({ name }) => name),
      [
        'claim_profile_avatar_reconciliation',
        'claim_account_storage_cleanup',
        'claim_stale_course_presentations',
        'prune_terminal_avatar_upload_operations',
        'prune_signup_legal_operations',
        'prune_terminal_auth_admin_outbox',
        'prune_account_storage_cleanup_tombstones',
        'prune_coarse_ip_rate_limits',
        'prune_learning_history_delete_receipts',
        'prune_certificate_export_jobs',
        'collect_capacity_monitor_snapshot',
      ],
    );
  } finally {
    loaded.restore();
  }
});

test('presentation cleanup validates and removes staging and retired public objects by bucket', async () => {
  const secret = 'test-only-secret-material-'.repeat(2);
  const stagingId = '55555555-5555-4555-8555-555555555555';
  const publicId = '66666666-6666-4666-8666-666666666666';
  const actorId = '77777777-7777-4777-8777-777777777777';
  const sha256 = 'a'.repeat(64);
  const removals = [];
  const completions = [];
  const client = {
    rpc: async (name, args) => {
      if (
        name === 'claim_profile_avatar_reconciliation' ||
        name === 'claim_account_storage_cleanup'
      ) {
        return { data: [], error: null };
      }
      if (name === 'claim_stale_course_presentations') {
        return {
          data: {
            items: [
              {
                id: stagingId,
                bucket: 'course-presentations-staging',
                path: `${actorId}/${publicId}/source.pdf`,
                thumbnailPath: `${actorId}/${publicId}/thumbnail.webp`,
                sha256,
                byteSize: 1024,
              },
              {
                id: publicId,
                bucket: 'course-presentations',
                path: `${actorId}/${publicId}/${sha256}.pdf`,
                thumbnailPath: `${actorId}/${publicId}/${sha256}-thumb.webp`,
                sha256,
                byteSize: 2048,
              },
            ],
          },
          error: null,
        };
      }
      if (name === 'complete_course_presentation_cleanup') {
        completions.push(args);
        return { data: { deleted: 2 }, error: null };
      }
      return { data: 0, error: null };
    },
    storage: {
      from: (bucket) => ({
        remove: async (paths) => {
          removals.push({ bucket, paths });
          return { data: [], error: null };
        },
      }),
    },
  };
  const loaded = await loadWorkerHandler(
    {
      STORAGE_RECONCILER_SECRET: secret,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role-key',
    },
    () => client,
  );
  try {
    const response = await loaded.handler(
      new Request('https://example.test/reconcile', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(removals, [
      {
        bucket: 'course-presentations-staging',
        paths: [`${actorId}/${publicId}/source.pdf`, `${actorId}/${publicId}/thumbnail.webp`],
      },
      {
        bucket: 'course-presentations',
        paths: [
          `${actorId}/${publicId}/${sha256}.pdf`,
          `${actorId}/${publicId}/${sha256}-thumb.webp`,
        ],
      },
    ]);
    assert.deepEqual(completions, [{ p_presentation_ids: [stagingId, publicId] }]);
  } finally {
    loaded.restore();
  }
});

test('runtime avatar cleanup handles the exact legacy key without weakening operation keys', async () => {
  const secret = 'test-only-secret-material-'.repeat(2);
  const userId = '11111111-1111-1111-1111-111111111111';
  const operationToken = '22222222-2222-2222-2222-222222222222';
  const objectKey = `${userId}/objects/${operationToken}.webp`;
  const legacyKey = `${userId}/avatar.webp`;

  async function runCase({ state, manifestKey, expectedRemoved, expectedStatus }) {
    let avatarClaimed = false;
    const removed = [];
    const completions = [];
    const client = {
      rpc: async (name, args) => {
        if (name === 'claim_stale_course_presentations') {
          return { data: { items: [] }, error: null };
        }
        if (name === 'claim_profile_avatar_reconciliation') {
          if (avatarClaimed) return { data: [], error: null };
          avatarClaimed = true;
          return {
            data: [
              {
                operationToken,
                userId,
                state,
                objectKey,
                previousObjectKey: legacyKey,
              },
            ],
            error: null,
          };
        }
        if (name === 'get_profile_avatar_manifest') {
          return { data: { objectKey: manifestKey }, error: null };
        }
        if (name === 'complete_profile_avatar_reconciliation') {
          completions.push(args);
          return {
            data: { operationToken, status: expectedStatus },
            error: null,
          };
        }
        if (name === 'claim_account_storage_cleanup') {
          return { data: [], error: null };
        }
        return { data: { deleted: 0 }, error: null };
      },
      storage: {
        from: (bucket) => {
          assert.equal(bucket, 'profile-avatars');
          return {
            remove: async (keys) => {
              removed.push(...keys);
              return { data: [], error: null };
            },
            download: async () => ({
              data: null,
              error: { status: 404, statusCode: '404' },
            }),
          };
        },
      },
    };
    const loaded = await loadWorkerHandler(
      {
        STORAGE_RECONCILER_SECRET: secret,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role-key',
      },
      () => client,
    );
    try {
      const response = await loaded.handler(
        new Request('https://example.test/reconcile', {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}` },
        }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(removed, [expectedRemoved]);
      assert.equal(completions.length, 1);
      assert.equal(completions[0].p_outcome, 'cleaned');
    } finally {
      loaded.restore();
    }
  }

  await runCase({
    state: 'committed',
    manifestKey: objectKey,
    expectedRemoved: legacyKey,
    expectedStatus: 'committed',
  });
  await runCase({
    state: 'cancel_requested',
    manifestKey: legacyKey,
    expectedRemoved: objectKey,
    expectedStatus: 'aborted',
  });
});

test('runtime post-purge tombstones are re-scanned and never purge Auth again', async () => {
  const secret = 'test-only-secret-material-'.repeat(2);
  const userId = '33333333-3333-3333-3333-333333333333';
  const tombstoneId = '44444444-4444-4444-4444-444444444444';
  let accountClaimed = false;
  let listCalls = 0;
  let purgeCalls = 0;
  const advanceCalls = [];
  const client = {
    rpc: async (name, args) => {
      if (name === 'claim_stale_course_presentations') {
        return { data: { items: [] }, error: null };
      }
      if (name === 'claim_profile_avatar_reconciliation') {
        return { data: [], error: null };
      }
      if (name === 'claim_account_storage_cleanup') {
        if (accountClaimed) return { data: [], error: null };
        accountClaimed = true;
        return {
          data: [
            {
              tombstoneId,
              userId,
              storagePrefix: `${userId}/`,
              state: 'post_purge_cleanup',
            },
          ],
          error: null,
        };
      }
      if (name === 'advance_account_storage_cleanup') {
        advanceCalls.push(args);
        return {
          data: { tombstoneId, state: 'post_purge_empty_once' },
          error: null,
        };
      }
      if (name === 'purge_user_account') {
        purgeCalls += 1;
        return { data: null, error: new Error('must not run') };
      }
      return { data: { deleted: 0 }, error: null };
    },
    storage: {
      from: (bucket) => {
        assert.equal(bucket, 'profile-avatars');
        return {
          list: async () => {
            listCalls += 1;
            return { data: [], error: null };
          },
          remove: async () => ({ data: [], error: null }),
        };
      },
    },
  };
  const loaded = await loadWorkerHandler(
    {
      STORAGE_RECONCILER_SECRET: secret,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role-key',
    },
    () => client,
  );
  try {
    const response = await loaded.handler(
      new Request('https://example.test/reconcile', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(listCalls, 2);
    assert.equal(purgeCalls, 0);
    assert.equal(advanceCalls.length, 1);
    assert.equal(advanceCalls[0].p_outcome, 'empty');
  } finally {
    loaded.restore();
  }
});

test('avatar cleanup is restricted to validated immutable keys and protects the manifest', async () => {
  const [worker, migration] = await Promise.all([read(workerFile), read(migrationFile)]);

  assert.match(worker, /AVATAR_OBJECT_PATTERN = new RegExp\([\s\S]*\/objects\/[\s\S]*\\\\\.webp/u);
  assert.match(worker, /parseAvatarObjectKey\(value\.objectKey, userId, operationToken\)/u);
  assert.match(
    worker,
    /value === `\$\{expectedUserId\}\/avatar\.webp`[\s\S]*parseAvatarObjectKey\(value, expectedUserId\)/u,
  );
  assert.match(worker, /parsePublishedAvatarObjectKey\(value\.previousObjectKey, userId\)/u);
  assert.match(worker, /parsePublishedAvatarObjectKey\(value\.objectKey, userId\)/u);
  assert.match(
    worker,
    /operation\.previousObjectKey !== committedObjectKey[\s\S]*removeObjects\(client, \[operation\.previousObjectKey\]\)[\s\S]*objectExists\(client, operation\.previousObjectKey\)/u,
  );
  assert.match(
    worker,
    /operation\.objectKey === committedObjectKey[\s\S]*AVATAR_MANIFEST_CONFLICT[\s\S]*removeObjects\(client, \[operation\.objectKey\]\)[\s\S]*objectExists\(client, operation\.objectKey\)/u,
  );
  assert.doesNotMatch(worker, /removeObjects\(client, \[committedObjectKey\]\)/u);
  assert.match(worker, /status === 404 \|\| statusCode === '404' \|\| statusCode === 'not_found'/u);
  assert.doesNotMatch(worker, /(?:status|statusCode)[^\n]*includes\(['"]404/u);
  assert.doesNotMatch(
    worker,
    /parsePublishedAvatarObjectKey\(value\.objectKey, userId, operationToken\)/u,
  );
  assert.match(
    migration,
    /legacy_imported[\s\S]*object_key = user_id::text \|\| '\/avatar\.webp'/u,
  );
  assert.match(
    migration,
    /select profile\.id, profile\.id::text \|\| '\/avatar\.webp'[\s\S]*true, profile\.avatar_updated_at/u,
  );
});

test('account cleanup recursively paginates within hard bounds and re-lists after deletion', async () => {
  const worker = await read(workerFile);
  const cleanup = worker.slice(
    worker.indexOf('async function reconcileAccountCleanup'),
    worker.indexOf('async function claimOne'),
  );

  assert.match(worker, /const PAGE_SIZE = 100;/u);
  assert.match(worker, /const MAX_OBJECTS_PER_PREFIX = 5_000;/u);
  assert.match(worker, /const MAX_FOLDERS_PER_PREFIX = 128;/u);
  assert.match(worker, /const MAX_LIST_REQUESTS_PER_PREFIX = 256;/u);
  assert.match(
    worker,
    /ACCOUNT_CLEANUP_ADVANCE_STATES = new Set\(\[\s*'cleanup_pending',[\s\S]*'post_purge_cleanup',[\s\S]*'db_purged'/u,
  );
  assert.match(worker, /if \(storagePrefix !== `\$\{root\}\/` \|\| !UUID_PATTERN\.test\(root\)\)/u);
  assert.match(
    worker,
    /\.list\(folder, \{\s*limit: PAGE_SIZE,\s*offset,\s*sortBy: \{ column: 'name', order: 'asc' \}/u,
  );
  assert.match(worker, /if \(entry\.id === null\)[\s\S]*pendingFolders\.push\(path\)/u);
  assert.match(worker, /objects\.size > MAX_OBJECTS_PER_PREFIX/u);
  assert.match(worker, /listRequests > MAX_LIST_REQUESTS_PER_PREFIX/u);
  assert.match(worker, /knownFolders\.size >= MAX_FOLDERS_PER_PREFIX/u);
  assert.match(worker, /objects\.slice\(index, index \+ PAGE_SIZE\)/u);

  const firstList = cleanup.indexOf('listPrefix(client, tombstone.storagePrefix)');
  const removal = cleanup.indexOf('removeObjects(client, objects)');
  const secondList = cleanup.indexOf('listPrefix(client, tombstone.storagePrefix)', firstList + 1);
  const advance = cleanup.indexOf("rpc(client, 'advance_account_storage_cleanup'");
  assert.ok(firstList >= 0 && removal > firstList && secondList > removal && advance > secondList);
  assert.match(cleanup, /p_outcome: remaining\.length === 0 \? 'empty' : 'nonempty'/u);
  assert.doesNotMatch(cleanup, /p_outcome:\s*'empty'[\s\S]*removeObjects/u);
});

test('database owns the two-empty-scan gate, leases, backoff, and service-only RPC boundary', async () => {
  const migration = await read(migrationFile);
  const flat = migration.replace(/\s+/gu, ' ');

  assert.match(flat, /statement_timestamp\(\) \+ interval '15 minutes'/u);
  assert.match(
    flat,
    /v_tombstone\.state = 'empty_once' and v_tombstone\.empty_confirmed_at <= statement_timestamp\(\) - interval '2 minutes'/u,
  );
  assert.match(
    flat,
    /set state = 'storage_cleared', storage_cleared_at = statement_timestamp\(\)/u,
  );
  assert.match(
    flat,
    /state in \('post_purge_cleanup', 'post_purge_empty_once'\)[\s\S]*state = 'db_purged'/u,
  );
  assert.match(flat, /lease_expires_at = statement_timestamp\(\) \+ interval '5 minutes'/u);
  assert.match(
    flat,
    /operation\.storage_write_lease_expires_at is null or operation\.storage_write_lease_expires_at <= statement_timestamp\(\)/u,
  );
  assert.match(
    flat,
    /claim_account_storage_cleanup[\s\S]*not exists \( select 1 from private\.avatar_upload_operations operation[\s\S]*operation\.storage_write_lease_expires_at > statement_timestamp\(\)/u,
  );
  assert.match(
    flat,
    /p_outcome in \('nonempty', 'retry'\)[\s\S]*next_attempt_at = statement_timestamp\(\) \+ make_interval/u,
  );
  assert.match(
    flat,
    /v_tombstone\.state = 'storage_cleared'[\s\S]*p_outcome is distinct from 'retry'[\s\S]*lease_owner = null, lease_expires_at = null/u,
  );
  assert.match(
    flat,
    /create function private\.guard_auth_user_avatar_cleanup\(\)[\s\S]*if not \( coalesce\( current_setting\('safetyhub\.storage_purge_user_id', true\), '' \) = old\.id::text and exists \([\s\S]*tombstone\.state = 'storage_cleared'[\s\S]*message = 'ACCOUNT_STORAGE_CLEANUP_PENDING'/u,
  );
  const authDeleteGuard = flat.slice(
    flat.indexOf('create function private.guard_auth_user_avatar_cleanup()'),
    flat.indexOf('drop trigger if exists auth_users_avatar_cleanup_guard'),
  );
  assert.doesNotMatch(authDeleteGuard, /profile_avatar_manifests|avatar_upload_operations/u);

  for (const signature of [
    'get_profile_avatar_manifest\\(uuid\\)',
    'claim_profile_avatar_reconciliation\\(uuid,integer\\)',
    'complete_profile_avatar_reconciliation\\(uuid,uuid,text,text\\)',
    'claim_account_storage_cleanup\\(uuid,integer\\)',
    'advance_account_storage_cleanup\\(uuid,uuid,text,text\\)',
    'purge_user_account\\(uuid\\)',
    'prune_terminal_avatar_upload_operations\\(integer\\)',
    'prune_signup_legal_operations\\(integer\\)',
    'prune_terminal_auth_admin_outbox\\(integer\\)',
    'prune_account_storage_cleanup_tombstones\\(integer\\)',
    'prune_coarse_ip_rate_limits\\(integer\\)',
  ]) {
    assert.match(
      flat,
      new RegExp(
        `revoke execute on function public\\.${signature} from public, anon, authenticated, service_role`,
        'u',
      ),
    );
    assert.match(
      flat,
      new RegExp(`grant execute on function public\\.${signature} to service_role`, 'u'),
    );
  }
});

test('claims are leased just in time and failures go through durable retry RPCs', async () => {
  const worker = await read(workerFile);

  assert.match(worker, /p_worker_id: workerId, p_limit: 1/u);
  assert.match(worker, /MAX_AVATAR_OPERATIONS_PER_RUN/u);
  assert.match(worker, /MAX_ACCOUNT_TOMBSTONES_PER_RUN/u);
  assert.match(worker, /Date\.now\(\) < avatarDeadline/u);
  assert.match(worker, /Date\.now\(\) < totalDeadline/u);
  assert.match(
    worker,
    /complete_profile_avatar_reconciliation[\s\S]*p_outcome: 'retry'[\s\S]*machineCode\(error, 'AVATAR_RECONCILE_RETRY'\)/u,
  );
  assert.match(
    worker,
    /advance_account_storage_cleanup[\s\S]*p_outcome: 'retry'[\s\S]*machineCode\(error, 'STORAGE_CLEANUP_RETRY'\)/u,
  );
  assert.match(
    worker,
    /result\.userId !== userId[\s\S]*result\.deleted === true[\s\S]*result\.postPurgeCleanupPending === true[\s\S]*result\.alreadyAbsent === true[\s\S]*!purgeConfirmed[\s\S]*ACCOUNT_PURGE_NOT_CONFIRMED/u,
  );
  assert.match(worker, /state === 'storage_cleared'[\s\S]*await purgeAccount/u);
  assert.match(worker, /nextState === 'storage_cleared'[\s\S]*await purgeAccount/u);
  assert.doesNotMatch(worker, /console\.(?:log|warn|info|debug)\(/u);
  assert.match(worker, /console\.error\('STORAGE_RECONCILER_FAILED', \{\s*code: machineCode/u);
});

test('runbook documents secure scheduling and recoverable shutdown', async () => {
  const readme = await read('docs/operations.md');

  assert.match(readme, /Supabase Functions secrets/u);
  assert.match(readme, /Supabase Vault/u);
  assert.match(readme, /Секрет нельзя помещать прямо в cron SQL/u);
  assert.match(
    readme,
    /два полных пустых сканирования с интервалом не менее двух минут[\s\S]*ещё два таких сканирования/u,
  );
  assert.match(readme, /Для аварийной остановки сначала отключается расписание/u);
  assert.match(
    readme,
    /Нельзя вручную удалять operation rows, tombstones, manifests или Storage prefixes/u,
  );
  assert.match(readme, /\{userId\}\/objects\/\{operationToken\}\.webp/u);
  assert.match(readme, /## Storage reconciler/u);
});
