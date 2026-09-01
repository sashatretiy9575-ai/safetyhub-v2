import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DISPOSABLE_PROJECT_MARKER,
  PRODUCTION_PROJECT_REF,
  PROTECTED_PROJECT_REFS,
} from '../../scripts/load-test-safety.mjs';
import {
  inspectDisposableStorageTarget,
  main as rehearseStorageRestore,
  materializeVerifiedStorageBackup,
  parseArguments,
} from '../../scripts/rehearse-linked-storage-restore.mjs';
import { OperatorToolError } from '../../scripts/storage-operator-tools.mjs';
import {
  SAFETYHUB_STORAGE_BUCKET_ALLOWLIST,
  readVerifiedStorageByteBackupForRestore,
  runStorageByteBackup,
} from '../../scripts/storage-byte-backup-tools.mjs';

const BUCKETS = [...SAFETYHUB_STORAGE_BUCKET_ALLOWLIST];
const TARGET_REF = 'aaaaaaaaaaaaaaaaaaaa';
const PASSPHRASE = Buffer.alloc(48, 0x41).toString('base64');
const SERVICE_KEY = `sb_secret_${'s'.repeat(48)}`;
const ACCESS_TOKEN = `sbp_${'t'.repeat(48)}`;
const OBJECT_BYTES = Buffer.from('verified restore rehearsal bytes');

function bucketConfigurations() {
  return new Map(
    BUCKETS.map((bucket) => [
      bucket,
      {
        id: bucket,
        name: bucket,
        public: bucket === 'content-media' || bucket === 'course-presentations',
        file_size_limit: bucket === 'content-media' ? null : 52_428_800,
        allowed_mime_types:
          bucket === 'content-media'
            ? ['image/webp']
            : bucket === 'profile-avatars'
              ? ['image/webp']
              : ['application/pdf', 'image/webp'],
      },
    ]),
  );
}

function webStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function backupClient(configurations) {
  return {
    storage: {
      async listBuckets() {
        return { data: [...configurations.values()], error: null };
      },
      async getBucket(bucket) {
        return { data: configurations.get(bucket), error: null };
      },
      from(bucket) {
        return {
          async list(prefix) {
            return {
              data:
                bucket === 'content-media' && prefix === ''
                  ? [
                      {
                        name: 'asset.webp',
                        id: 'source-object-id',
                        created_at: '2026-09-01T00:00:00.000Z',
                        updated_at: '2026-09-01T00:00:00.000Z',
                        last_accessed_at: '2026-09-01T00:00:00.000Z',
                        metadata: {
                          size: OBJECT_BYTES.length,
                          mimetype: 'image/webp',
                          eTag: 'source-etag',
                        },
                      },
                    ]
                  : [],
              error: null,
            };
          },
          download(key) {
            return {
              async asStream() {
                return bucket === 'content-media' && key === 'asset.webp'
                  ? { data: webStream(OBJECT_BYTES), error: null }
                  : { data: null, error: { message: 'not found' } };
              },
            };
          },
        };
      },
    },
  };
}

function targetClient(configurations) {
  const objects = new Map();
  const calls = { uploads: [] };
  return {
    calls,
    objects,
    client: {
      storage: {
        async listBuckets() {
          return { data: [...configurations.values()], error: null };
        },
        async getBucket(bucket) {
          return { data: configurations.get(bucket), error: null };
        },
        from(bucket) {
          return {
            async list(prefix, options) {
              const keys = [...objects.keys()]
                .filter((key) => key.startsWith(`${bucket}\0`))
                .map((key) => key.slice(bucket.length + 1));
              const direct = new Map();
              for (const key of keys) {
                if (prefix && !key.startsWith(`${prefix}/`)) continue;
                const remainder = prefix ? key.slice(prefix.length + 1) : key;
                const [name, ...tail] = remainder.split('/');
                if (tail.length > 0) direct.set(name, { name, id: null, metadata: null });
                else
                  direct.set(name, {
                    name,
                    id: `target-${name}`,
                    metadata: { size: objects.get(`${bucket}\0${key}`).length },
                  });
              }
              return {
                data: [...direct.values()]
                  .sort((left, right) => left.name.localeCompare(right.name, 'en'))
                  .slice(options.offset, options.offset + options.limit),
                error: null,
              };
            },
            async upload(key, stream, options) {
              calls.uploads.push({ bucket, key, options });
              const objectId = `${bucket}\0${key}`;
              if (options.upsert !== false || objects.has(objectId)) {
                return { data: null, error: { message: 'conflict' } };
              }
              const chunks = [];
              for await (const chunk of stream) chunks.push(Buffer.from(chunk));
              objects.set(objectId, Buffer.concat(chunks));
              return { data: { path: key }, error: null };
            },
            download(key) {
              return {
                async asStream() {
                  const bytes = objects.get(`${bucket}\0${key}`);
                  return bytes
                    ? { data: webStream(bytes), error: null }
                    : { data: null, error: { message: 'not found' } };
                },
              };
            },
          };
        },
      },
    },
  };
}

function baseArguments(root, targetRef = TARGET_REF) {
  return [
    '--backup',
    path.join(root, 'backup-placeholder'),
    '--expected-source-project-ref',
    PRODUCTION_PROJECT_REF,
    ...BUCKETS.flatMap((bucket) => ['--allow-bucket', bucket]),
    '--target-project-ref',
    targetRef,
    '--confirm-target-project-ref',
    targetRef,
    '--confirm-disposable-project',
    DISPOSABLE_PROJECT_MARKER,
    '--env-file',
    path.join(root, 'target.env'),
    '--recovery-key-file',
    path.join(root, 'recovery.key'),
  ];
}

test('Storage restore rehearsal hard-denies current and previous production aliases', () => {
  const root = path.resolve(os.tmpdir(), 'safetyhub-restore-parse');
  for (const protectedRef of PROTECTED_PROJECT_REFS) {
    assert.throws(
      () => parseArguments(baseArguments(root, protectedRef)),
      (error) =>
        error instanceof OperatorToolError &&
        error.code === 'STORAGE_RESTORE_DISPOSABLE_TARGET_REQUIRED',
    );
  }
  const parsed = parseArguments(baseArguments(root));
  assert.equal(parsed.sourceProjectRef, PRODUCTION_PROJECT_REF);
  assert.equal(parsed.targetProjectRef, TARGET_REF);
  assert.deepEqual(parsed.buckets, BUCKETS);
});

test('Storage restore materializes only a fully authenticated fixed-entry archive', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-restore-materialize-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  const temporaryDirectory = path.join(sandbox, 'temporary');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory), mkdir(temporaryDirectory)]);
  try {
    const receipt = await runStorageByteBackup({
      client: backupClient(bucketConfigurations()),
      expectedProjectRef: PRODUCTION_PROJECT_REF,
      buckets: BUCKETS,
      archivePassphrase: PASSPHRASE,
      outputDirectory,
      repositoryRoot,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });
    const verifiedBackup = await readVerifiedStorageByteBackupForRestore({
      backupDirectory: receipt.runDirectory,
      expectedProjectRef: PRODUCTION_PROJECT_REF,
      buckets: BUCKETS,
      archivePassphrase: PASSPHRASE,
    });
    const materialized = await materializeVerifiedStorageBackup({
      verifiedBackup,
      archivePassphrase: PASSPHRASE,
      temporaryDirectory,
    });
    assert.deepEqual(
      await readFile(path.join(materialized.extractionDirectory, 'objects', '00000001.bin')),
      OBJECT_BYTES,
    );
    assert.equal(
      await readFile(path.join(temporaryDirectory, 'verified-storage.tar')).catch(() => null),
      null,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('Storage restore verifies disposable marker, exact empty target, uploads once, and re-hashes', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-restore-main-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  const recoveryKeyFile = path.join(sandbox, 'recovery.key');
  const environmentFile = path.join(sandbox, 'target.env');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const configurations = bucketConfigurations();
  const target = targetClient(configurations);
  let output = '';
  let managementChecks = 0;
  try {
    const receipt = await runStorageByteBackup({
      client: backupClient(configurations),
      expectedProjectRef: PRODUCTION_PROJECT_REF,
      buckets: BUCKETS,
      archivePassphrase: PASSPHRASE,
      outputDirectory,
      repositoryRoot,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });
    await writeFile(recoveryKeyFile, `SAFETYHUB-STORAGE-RECOVERY-KEY-V1:${PASSPHRASE}\n`);
    await writeFile(
      environmentFile,
      `SUPABASE_SECRET_KEY=${SERVICE_KEY}\nSUPABASE_ACCESS_TOKEN=${ACCESS_TOKEN}\n`,
    );
    const argv = baseArguments(sandbox);
    argv[1] = receipt.runDirectory;
    const summary = await rehearseStorageRestore(argv, {
      fetchImpl: async (url) => {
        assert.equal(url, `https://api.supabase.com/v1/projects/${TARGET_REF}`);
        managementChecks += 1;
        return new Response(
          JSON.stringify({ id: TARGET_REF, ref: TARGET_REF, name: DISPOSABLE_PROJECT_MARKER }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      createClientImpl(url, key, options) {
        assert.equal(url, `https://${TARGET_REF}.supabase.co`);
        assert.equal(key, SERVICE_KEY);
        assert.equal(typeof options.global.fetch, 'function');
        return target.client;
      },
      writeOutput: (value) => {
        output += value;
      },
    });
    assert.equal(managementChecks, 2);
    assert.equal(summary.restoredObjects, 1);
    assert.equal(summary.restoredBytes, OBJECT_BYTES.length);
    assert.equal(summary.temporaryPlaintextRemoved, true);
    assert.equal(target.calls.uploads.length, 1);
    assert.equal(target.calls.uploads[0].options.upsert, false);
    assert.deepEqual(target.objects.get('content-media\0asset.webp'), OBJECT_BYTES);
    assert.doesNotMatch(output, /asset\.webp|sb_secret_|sbp_|DISPOSABLE SECURITY TEST/u);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('Storage restore target preflight rejects any nonempty bucket before upload', async () => {
  const configurations = bucketConfigurations();
  const target = targetClient(configurations);
  target.objects.set('profile-avatars\0existing/avatar.webp', Buffer.from('existing'));
  const expectedConfigurations = Object.fromEntries(
    [...configurations].map(([bucket, value]) => [
      bucket,
      {
        id: bucket,
        public: value.public,
        fileSizeLimitBytes: value.file_size_limit,
        allowedMimeTypes: value.allowed_mime_types,
      },
    ]),
  );
  const inventory = await inspectDisposableStorageTarget(
    target.client,
    BUCKETS,
    expectedConfigurations,
  );
  assert.deepEqual(inventory['profile-avatars'], ['existing/avatar.webp']);
});
