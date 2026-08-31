import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OperatorToolError,
} from '../../scripts/storage-operator-tools.mjs';
import {
  SAFETYHUB_STORAGE_BUCKET_ALLOWLIST,
  runStorageByteBackup,
  validateStorageBackupRequest,
  verifyStorageByteBackup,
} from '../../scripts/storage-byte-backup-tools.mjs';

const PROJECT_REF = 'vezgxdooijznpjqrpvcv';
const FIXED_NOW = new Date('2026-08-31T01:00:00.000Z');
const PASSPHRASE = 'storage-backup-test-passphrase-with-more-than-32-bytes';
const BUCKETS = [...SAFETYHUB_STORAGE_BUCKET_ALLOWLIST];

function folder(name) {
  return { name, id: null, metadata: null };
}

function object(name, size, metadata = {}) {
  return {
    name,
    id: `metadata-${name}`,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:05:00.000Z',
    metadata: { size, mimetype: 'application/octet-stream', eTag: `etag-${name}`, ...metadata },
  };
}

function objectMapKey(bucket, key) {
  return `${bucket}\0${key}`;
}

function storageStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function mockStorageClient({ bucketConfigs, trees, downloads, listedBucketConfigs = bucketConfigs }) {
  const calls = { bucketInventories: 0, bucketReads: [], lists: [], downloads: [], mutations: [] };
  const client = {
    storage: {
      async listBuckets() {
        calls.bucketInventories += 1;
        return { data: [...listedBucketConfigs.values()], error: null };
      },
      async getBucket(bucket) {
        calls.bucketReads.push(bucket);
        const data = bucketConfigs.get(bucket);
        return data ? { data, error: null } : { data: null, error: { message: `not found ${bucket}` } };
      },
      from(bucket) {
        if (!bucketConfigs.has(bucket)) throw new Error(`unexpected bucket ${bucket}`);
        return {
          async list(prefix, options) {
            calls.lists.push({ bucket, prefix, options });
            const entries = trees.get(objectMapKey(bucket, prefix)) ?? [];
            return {
              data: entries.slice(options.offset, options.offset + options.limit),
              error: null,
            };
          },
          download(key) {
            calls.downloads.push({ bucket, key });
            const bytes = downloads.get(objectMapKey(bucket, key));
            return {
              async asStream() {
                return bytes === undefined
                  ? { data: null, error: { message: `no object ${bucket}/${key}` } }
                  : { data: storageStream(bytes), error: null };
              },
            };
          },
          remove() {
            calls.mutations.push('remove');
            throw new Error('mutation must never be called');
          },
          upload() {
            calls.mutations.push('upload');
            throw new Error('mutation must never be called');
          },
        };
      },
    },
  };
  return { client, calls };
}

function fullFixture() {
  const bucketConfigs = new Map([
    [
      'content-media',
      {
        id: 'content-media',
        name: 'content-media',
        public: true,
        file_size_limit: null,
        allowed_mime_types: ['image/webp'],
      },
    ],
    [
      'course-presentations',
      {
        id: 'course-presentations',
        name: 'course-presentations',
        public: true,
        file_size_limit: 52_428_800,
        allowed_mime_types: ['application/pdf', 'image/webp'],
      },
    ],
    [
      'course-presentations-staging',
      {
        id: 'course-presentations-staging',
        name: 'course-presentations-staging',
        public: false,
        file_size_limit: 52_428_800,
        allowed_mime_types: ['application/pdf', 'image/webp'],
      },
    ],
    [
      'profile-avatars',
      {
        id: 'profile-avatars',
        name: 'profile-avatars',
        public: false,
        file_size_limit: 102_400,
        allowed_mime_types: ['image/webp'],
      },
    ],
  ]);
  const trees = new Map([
    [
      objectMapKey('content-media', ''),
      [object('00.webp', '0', { eTag: 'zero-byte-etag' }), folder('nested')],
    ],
    [objectMapKey('content-media', 'nested'), [object('asset.webp', 5, { mimetype: 'image/webp' })]],
    [
      objectMapKey('course-presentations', ''),
      [folder('published'), object('orphan.pdf', 6, { mimetype: 'application/pdf' })],
    ],
    [
      objectMapKey('course-presentations', 'published'),
      [object('course.pdf', 7, { mimetype: 'application/pdf' })],
    ],
    [objectMapKey('course-presentations-staging', ''), [folder('drafts')]],
    [
      objectMapKey('course-presentations-staging', 'drafts'),
      [object('draft.pdf', 8, { mimetype: 'application/pdf' })],
    ],
    [objectMapKey('profile-avatars', ''), [folder('user-private')]],
    [
      objectMapKey('profile-avatars', 'user-private'),
      [object('avatar.webp', 9, { mimetype: 'image/webp', eTag: 'private-avatar-etag' })],
    ],
  ]);
  const downloads = new Map([
    [objectMapKey('content-media', '00.webp'), Buffer.alloc(0)],
    [objectMapKey('content-media', 'nested/asset.webp'), Buffer.from('media')],
    [objectMapKey('course-presentations', 'orphan.pdf'), Buffer.from('orphan')],
    [objectMapKey('course-presentations', 'published/course.pdf'), Buffer.from('course!')],
    [objectMapKey('course-presentations-staging', 'drafts/draft.pdf'), Buffer.from('draftpdf')],
    [objectMapKey('profile-avatars', 'user-private/avatar.webp'), Buffer.from('avatarimg')],
  ]);
  return { bucketConfigs, trees, downloads };
}

test('generic Storage backup requires the exact four-bucket allowlist before any remote access', async () => {
  const incomplete = BUCKETS.slice(0, -1);
  assert.throws(
    () => validateStorageBackupRequest({ expectedProjectRef: PROJECT_REF, buckets: incomplete }),
    (error) => error instanceof OperatorToolError && error.code === 'STORAGE_BACKUP_BUCKET_SET_INCOMPLETE',
  );
  assert.throws(
    () =>
      validateStorageBackupRequest({
        expectedProjectRef: PROJECT_REF,
        buckets: [...BUCKETS, 'unreviewed-bucket'],
      }),
    (error) => error instanceof OperatorToolError && error.code === 'STORAGE_BACKUP_BUCKET_NOT_ALLOWED',
  );
  assert.throws(
    () => validateStorageBackupRequest({ expectedProjectRef: 'not-a-project-ref', buckets: BUCKETS }),
    (error) => error instanceof OperatorToolError && error.code === 'STORAGE_BACKUP_PROJECT_REF_INVALID',
  );

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-storage-preflight-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const fixture = fullFixture();
  const listedBucketConfigs = new Map(fixture.bucketConfigs);
  fixture.bucketConfigs.set('content-media', {
    id: 'wrong-id',
    name: 'content-media',
    public: true,
    file_size_limit: null,
    allowed_mime_types: null,
  });
  const mocked = mockStorageClient({ ...fixture, listedBucketConfigs });
  try {
    await assert.rejects(
      runStorageByteBackup({
        client: mocked.client,
        expectedProjectRef: PROJECT_REF,
        buckets: BUCKETS,
        archivePassphrase: PASSPHRASE,
        outputDirectory,
        repositoryRoot,
      }),
      (error) =>
        error instanceof OperatorToolError &&
        error.code === 'STORAGE_BACKUP_BUCKET_CONFIGURATION_MISMATCH',
    );
    assert.deepEqual(mocked.calls.lists, []);
    assert.deepEqual(mocked.calls.downloads, []);
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('generic Storage backup fails closed when the visible project bucket inventory differs', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-storage-inventory-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const fixture = fullFixture();
  fixture.bucketConfigs.set('unexpected-legacy-bucket', {
    id: 'unexpected-legacy-bucket',
    name: 'unexpected-legacy-bucket',
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
  });
  const mocked = mockStorageClient(fixture);
  try {
    await assert.rejects(
      runStorageByteBackup({
        client: mocked.client,
        expectedProjectRef: PROJECT_REF,
        buckets: BUCKETS,
        archivePassphrase: PASSPHRASE,
        outputDirectory,
        repositoryRoot,
      }),
      (error) =>
        error instanceof OperatorToolError &&
        error.code === 'STORAGE_BACKUP_BUCKET_INVENTORY_MISMATCH',
    );
    assert.equal(mocked.calls.bucketInventories, 1);
    assert.deepEqual(mocked.calls.bucketReads, []);
    assert.deepEqual(mocked.calls.lists, []);
    assert.deepEqual(mocked.calls.downloads, []);
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('generic Storage backup recursively encrypts every visible object across public and private buckets', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-storage-byte-backup-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const fixture = fullFixture();
  const mocked = mockStorageClient(fixture);
  const rawKeys = [...fixture.downloads.keys()];
  const rawBytes = [...fixture.downloads.values()];
  try {
    const receipt = await runStorageByteBackup({
      client: mocked.client,
      expectedProjectRef: PROJECT_REF,
      buckets: [...BUCKETS].reverse(),
      archivePassphrase: PASSPHRASE,
      outputDirectory,
      repositoryRoot,
      pageSize: 2,
      now: () => FIXED_NOW,
    });

    assert.equal(receipt.archivedObjects, rawKeys.length);
    assert.equal(receipt.archivedBytes, rawBytes.reduce((sum, bytes) => sum + bytes.length, 0));
    assert.deepEqual(receipt.buckets, BUCKETS);
    const expectedDatabaseCompatibleObjectSet = [
      ['content-media', '00.webp', 0, 'zero-byte-etag'],
      ['content-media', 'nested/asset.webp', 5, 'etag-asset.webp'],
      ['course-presentations', 'orphan.pdf', 6, 'etag-orphan.pdf'],
      ['course-presentations', 'published/course.pdf', 7, 'etag-course.pdf'],
      ['course-presentations-staging', 'drafts/draft.pdf', 8, 'etag-draft.pdf'],
      ['profile-avatars', 'user-private/avatar.webp', 9, 'private-avatar-etag'],
    ];
    assert.equal(
      receipt.objectSetSha256,
      createHash('sha256')
        .update(JSON.stringify(expectedDatabaseCompatibleObjectSet))
        .digest('hex'),
    );
    assert.deepEqual(
      mocked.calls.downloads.map(({ bucket, key }) => objectMapKey(bucket, key)).sort(),
      rawKeys.sort(),
    );
    assert.ok(mocked.calls.lists.some((call) => call.options.offset === 2));
    assert.deepEqual(mocked.calls.mutations, []);

    const runFiles = (await readdir(receipt.runDirectory)).sort();
    assert.deepEqual(runFiles, ['manifest.json.aes256gcm', 'receipt.json', 'storage.tar.aes256gcm']);
    const [archive, manifest, diskReceipt] = await Promise.all([
      readFile(path.join(receipt.runDirectory, 'storage.tar.aes256gcm')),
      readFile(path.join(receipt.runDirectory, 'manifest.json.aes256gcm')),
      readFile(path.join(receipt.runDirectory, 'receipt.json'), 'utf8'),
    ]);
    for (const rawKey of rawKeys) {
      assert.equal(archive.includes(Buffer.from(rawKey)), false);
      assert.equal(manifest.includes(Buffer.from(rawKey)), false);
      assert.equal(diskReceipt.includes(rawKey), false);
    }
    for (const bytes of rawBytes.filter((bytes) => bytes.length > 0)) {
      assert.equal(archive.includes(bytes), false);
      assert.equal(manifest.includes(bytes), false);
    }
    assert.equal(diskReceipt.includes('private-avatar-etag'), false);

    const verified = await verifyStorageByteBackup({
      backupDirectory: receipt.runDirectory,
      expectedProjectRef: PROJECT_REF,
      buckets: BUCKETS,
      archivePassphrase: PASSPHRASE,
    });
    assert.deepEqual(verified, {
      ok: true,
      projectRef: PROJECT_REF,
      buckets: BUCKETS,
      archivedObjects: rawKeys.length,
      archivedBytes: rawBytes.reduce((sum, bytes) => sum + bytes.length, 0),
      archiveAuthenticated: true,
      manifestAuthenticated: true,
      entryHashesVerified: true,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('generic Storage backup rejects a mismatched stream and removes every incomplete local artifact', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-storage-byte-mismatch-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const fixture = fullFixture();
  fixture.downloads.set(
    objectMapKey('course-presentations-staging', 'drafts/draft.pdf'),
    Buffer.from('too-short'),
  );
  const mocked = mockStorageClient(fixture);
  try {
    await assert.rejects(
      runStorageByteBackup({
        client: mocked.client,
        expectedProjectRef: PROJECT_REF,
        buckets: BUCKETS,
        archivePassphrase: PASSPHRASE,
        outputDirectory,
        repositoryRoot,
        now: () => FIXED_NOW,
      }),
      (error) => error instanceof OperatorToolError && error.code === 'STORAGE_DOWNLOAD_SIZE_MISMATCH',
    );
    assert.deepEqual(await readdir(outputDirectory), []);
    assert.deepEqual(mocked.calls.mutations, []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('generic Storage backup source has no cloud mutation, identity, or database access path', async () => {
  const sources = await Promise.all(
    [
      '../../scripts/storage-byte-backup-tools.mjs',
      '../../scripts/backup-linked-storage.mjs',
      '../../scripts/verify-linked-storage-backup.mjs',
    ].map((relative) => readFile(new URL(relative, import.meta.url), 'utf8')),
  );
  const source = sources.join('\n');
  assert.doesNotMatch(
    source,
    /\b(?:storage|bucket)\.(?:remove|upload|update|move|copy|emptyBucket|createBucket|deleteBucket)\s*\(/u,
  );
  assert.doesNotMatch(source, /\bauth\.admin\b|\bclient\.from\s*\(|\.rpc\s*\(/u);
  assert.match(source, /loadServiceCredentialFromEnvironmentFile/u);
  assert.match(source, /delete process\.env\[name\]/u);
  assert.match(source, /sourceConsistencyOrWriteDrainVerifiedByTool:\s*false/u);
  assert.match(source, /physicalBackendOrVersionInventoryPerformed:\s*false/u);
  assert.match(source, /exactVisibleBucketInventoryVerified:\s*true/u);
});
