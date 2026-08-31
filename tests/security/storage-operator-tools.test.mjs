import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AVATAR_ALLOWED_MIME_TYPES,
  AVATAR_BUCKET,
  AVATAR_FILE_SIZE_LIMIT_BYTES,
  OperatorToolError,
  PRODUCTION_PROJECT_REF,
  confirmProductionRef,
  readOperatorConfig,
  readServiceCredential,
  runAvatarBackup,
  runVisibleInventory,
  validateOperatorConfig,
  writeInventoryReport,
} from '../../scripts/storage-operator-tools.mjs';

const USER_ONE = '11111111-1111-4111-8111-111111111111';
const USER_TWO = '22222222-2222-4222-8222-222222222222';
const USER_THREE = '33333333-3333-4333-8333-333333333333';
const OPERATION_TOKEN = '44444444-4444-4444-8444-444444444444';
const FIXED_NOW = new Date('2026-08-14T00:00:00.000Z');

function rawConfig(operation, overrides = {}) {
  const common = {
    version: 1,
    operation,
    classificationMode: 'pre-700-visible-metadata',
    productionProjectRef: PRODUCTION_PROJECT_REF,
    supabaseUrl: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
    bucket: AVATAR_BUCKET,
    serviceRoleKeyEnv: 'SUPABASE_SECRET_KEY',
    pageSize: 2,
    requestTimeoutMs: 5_000,
  };
  if (operation === 'visible-inventory') {
    return {
      ...common,
      evidenceSaltEnv: 'STORAGE_INVENTORY_EVIDENCE_SALT',
      ...overrides,
    };
  }
  return {
    ...common,
    archivePassphraseEnv: 'STORAGE_BACKUP_ARCHIVE_PASSPHRASE',
    privateOutputAcknowledgement: 'private-directory-outside-repository-with-encryption-at-rest',
    ...overrides,
  };
}

function folder(name) {
  return { name, id: null, metadata: null };
}

function object(name, size, extra = {}) {
  const { metadata: metadataOverrides = {}, ...objectOverrides } = extra;
  return {
    name,
    id: objectOverrides.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    metadata: { size, mimetype: 'image/webp', ...metadataOverrides },
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
    ...objectOverrides,
  };
}

function mockClient({
  users,
  profiles,
  accountControls,
  tree,
  downloads = new Map(),
  bucketData = {
    id: AVATAR_BUCKET,
    name: AVATAR_BUCKET,
    public: false,
    file_size_limit: AVATAR_FILE_SIZE_LIMIT_BYTES,
    allowed_mime_types: [...AVATAR_ALLOWED_MIME_TYPES],
  },
  bucketError = null,
  streamDownloads = true,
}) {
  const calls = {
    authPages: [],
    profileRanges: [],
    accountControlRanges: [],
    bucketReads: [],
    lists: [],
    downloads: [],
  };
  const client = {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }) => {
          calls.authPages.push({ page, perPage });
          const from = (page - 1) * perPage;
          return { data: { users: users.slice(from, from + perPage) }, error: null };
        },
      },
    },
    from(table) {
      const specification = {
        profiles: {
          columns: 'id,avatar_updated_at',
          orderColumn: 'id',
          rows: profiles,
          ranges: calls.profileRanges,
        },
        account_controls: {
          columns: 'user_id,deletion_pending',
          orderColumn: 'user_id',
          rows: accountControls,
          ranges: calls.accountControlRanges,
        },
      }[table];
      assert.ok(specification, `unexpected table: ${table}`);
      const query = {
        select(columns) {
          assert.equal(columns, specification.columns);
          return query;
        },
        order(column, options) {
          assert.equal(column, specification.orderColumn);
          assert.deepEqual(options, { ascending: true });
          return query;
        },
        async range(from, to) {
          specification.ranges.push({ from, to });
          return { data: specification.rows.slice(from, to + 1), error: null };
        },
      };
      return query;
    },
    storage: {
      async getBucket(bucket) {
        calls.bucketReads.push(bucket);
        return { data: bucketData, error: bucketError };
      },
      from(bucket) {
        assert.equal(bucket, AVATAR_BUCKET);
        return {
          async list(prefix, options) {
            calls.lists.push({ prefix, options });
            const entries = tree.get(prefix) ?? [];
            return {
              data: entries.slice(options.offset, options.offset + options.limit),
              error: null,
            };
          },
          download(key) {
            calls.downloads.push(key);
            if (!downloads.has(key)) {
              return Promise.resolve({
                data: null,
                error: { message: `raw key must not escape: ${key}` },
              });
            }
            if (streamDownloads) {
              const bytes = downloads.get(key);
              return {
                asStream: async () => ({
                  data: new ReadableStream({
                    start(controller) {
                      controller.enqueue(new Uint8Array(bytes));
                      controller.close();
                    },
                  }),
                  error: null,
                }),
              };
            }
            return Promise.resolve({ data: new Blob([downloads.get(key)]), error: null });
          },
        };
      },
    },
  };
  return { client, calls };
}

function inventoryFixture() {
  const users = [
    { id: USER_ONE, email: 'private-one@example.test' },
    { id: USER_TWO, email: 'private-two@example.test' },
  ];
  const profiles = [
    { id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' },
    { id: USER_TWO, avatar_updated_at: '2026-08-13T02:00:00.000Z' },
    { id: USER_THREE, avatar_updated_at: '2026-08-13T03:00:00.000Z' },
  ];
  const accountControls = [
    { user_id: USER_ONE, deletion_pending: false },
    { user_id: USER_TWO, deletion_pending: false },
    { user_id: USER_THREE, deletion_pending: false },
  ];
  const tree = new Map([
    ['', [folder(USER_ONE), folder(USER_TWO), folder(USER_THREE), object('stray.webp', 7)]],
    [USER_ONE, [object('avatar.webp', 3)]],
    [USER_TWO, [folder('objects')]],
    [`${USER_TWO}/objects`, [object(`${OPERATION_TOKEN}.webp`, 4)]],
    [USER_THREE, [object('avatar.webp', 5)]],
  ]);
  return { users, profiles, accountControls, tree };
}

test('operator config is strict and production confirmation is exact', async () => {
  const inventory = validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory');
  assert.equal(inventory.productionProjectRef, PRODUCTION_PROJECT_REF);
  confirmProductionRef(inventory, PRODUCTION_PROJECT_REF);
  assert.throws(
    () => confirmProductionRef(inventory, `${PRODUCTION_PROJECT_REF}-typo`),
    (error) =>
      error instanceof OperatorToolError && error.code === 'PRODUCTION_REF_CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () =>
      validateOperatorConfig(
        rawConfig('visible-inventory', { serviceRoleKey: 'must-never-live-in-config' }),
        'visible-inventory',
      ),
    (error) => error instanceof OperatorToolError && error.code === 'CONFIG_UNKNOWN_FIELD',
  );
  assert.throws(
    () =>
      validateOperatorConfig(
        rawConfig('visible-inventory', {
          supabaseUrl: 'https://another-project.supabase.co',
        }),
        'visible-inventory',
      ),
    (error) => error instanceof OperatorToolError && error.code === 'CONFIG_PROJECT_URL_MISMATCH',
  );

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-operator-config-'));
  try {
    const malformed = path.join(temporary, 'malformed.json');
    await writeFile(malformed, '{ definitely-not-json', 'utf8');
    await assert.rejects(
      readOperatorConfig(malformed, 'visible-inventory'),
      (error) => error instanceof OperatorToolError && error.code === 'CONFIG_INVALID_JSON',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('server credential rejects a public key without logging or returning its value', () => {
  const config = validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory');
  const accepted = `sb_secret_${'a'.repeat(40)}`;
  assert.equal(readServiceCredential(config, { SUPABASE_SECRET_KEY: accepted }), accepted);
  const rejected = `sb_publishable_${'private-material'.repeat(3)}`;
  assert.throws(
    () => readServiceCredential(config, { SUPABASE_SECRET_KEY: rejected }),
    (error) => {
      assert.equal(error.code, 'SERVICE_KEY_WRONG_KIND');
      assert.equal(error.message.includes(rejected), false);
      return true;
    },
  );
});

test('visible inventory recursively paginates and emits only aggregates plus salted identifiers', async () => {
  const config = validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory');
  const firstMock = mockClient(inventoryFixture());
  const salt = Buffer.from('inventory-test-salt-material-at-least-32-bytes', 'utf8');
  const report = await runVisibleInventory({
    client: firstMock.client,
    config,
    evidenceSalt: salt,
    now: () => FIXED_NOW,
  });

  assert.equal(report.counts.visibleObjects, 4);
  assert.equal(report.counts.accountControls, 3);
  assert.equal(report.counts.deletionPendingAccountControls, 0);
  assert.equal(report.counts.eligibleForBackfillObjects, 1);
  assert.equal(report.counts.visibleMetadataBlockerObjects, 3);
  assert.equal(report.counts.visibleDirectoriesVisited, 5);
  assert.equal(report.visibleMetadataGate, 'blocked');
  assert.equal(report.coverage.physicalBackendOrVersionInventoryPerformed, false);
  assert.equal(report.coverage.readOnlyBucketConfigurationPreflightVerified, true);
  assert.deepEqual(report.verifiedBucketConfiguration, {
    private: true,
    fileSizeLimitBytes: AVATAR_FILE_SIZE_LIMIT_BYTES,
    allowedMimeTypes: ['image/webp'],
  });
  assert.equal(report.backendPhysicalOrVersionVerdict, 'not-assessed');
  assert.equal(report.blockerReasonCounts.pre700_immutable_object, 1);
  assert.equal(report.blockerReasonCounts.missing_live_auth_user, 1);
  assert.equal(report.blockerReasonCounts.malformed_or_nested_key, 1);
  assert.ok(
    report.findings.every((finding) => !('objectKey' in finding) && !('userId' in finding)),
  );
  assert.ok(
    report.findings.some((finding) =>
      (finding.objectFingerprint ?? finding.subjectFingerprint)?.startsWith('hmac-sha256:'),
    ),
  );

  const serialized = JSON.stringify(report);
  for (const rawIdentifier of [
    USER_ONE,
    USER_TWO,
    USER_THREE,
    OPERATION_TOKEN,
    `${USER_ONE}/avatar.webp`,
    'private-one@example.test',
    'private-two@example.test',
  ]) {
    assert.equal(serialized.includes(rawIdentifier), false);
  }
  assert.deepEqual(firstMock.calls.authPages, [
    { page: 1, perPage: 2 },
    { page: 2, perPage: 2 },
  ]);
  assert.deepEqual(firstMock.calls.bucketReads, [AVATAR_BUCKET]);
  assert.deepEqual(firstMock.calls.accountControlRanges, [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ]);
  assert.ok(firstMock.calls.lists.some((call) => call.prefix === `${USER_TWO}/objects`));
  assert.ok(firstMock.calls.lists.some((call) => call.prefix === '' && call.options.offset === 2));
  assert.ok(firstMock.calls.lists.some((call) => call.prefix === '' && call.options.offset === 4));

  const sameReport = await runVisibleInventory({
    client: mockClient(inventoryFixture()).client,
    config,
    evidenceSalt: salt,
    now: () => FIXED_NOW,
  });
  assert.deepEqual(sameReport.findings, report.findings);
  const otherReport = await runVisibleInventory({
    client: mockClient(inventoryFixture()).client,
    config,
    evidenceSalt: Buffer.from('different-inventory-salt-material-32-bytes', 'utf8'),
    now: () => FIXED_NOW,
  });
  assert.notDeepEqual(otherReport.findings, report.findings);
});

test('pre-700 candidates require an account control that is not deletion pending', async () => {
  const fixture = {
    users: [{ id: USER_ONE }, { id: USER_TWO }],
    profiles: [
      { id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' },
      { id: USER_TWO, avatar_updated_at: '2026-08-13T02:00:00.000Z' },
    ],
    accountControls: [{ user_id: USER_TWO, deletion_pending: true }],
    tree: new Map([
      ['', [folder(USER_ONE), folder(USER_TWO)]],
      [USER_ONE, [object('avatar.webp', 3)]],
      [USER_TWO, [object('avatar.webp', 4)]],
    ]),
  };
  const salt = Buffer.from('account-control-classifier-test-salt-material', 'utf8');
  const report = await runVisibleInventory({
    client: mockClient(fixture).client,
    config: validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory'),
    evidenceSalt: salt,
    now: () => FIXED_NOW,
  });

  assert.equal(report.counts.accountControls, 1);
  assert.equal(report.counts.deletionPendingAccountControls, 1);
  assert.equal(report.counts.authUsersWithoutAccountControl, 1);
  assert.equal(report.counts.eligibleForBackfillObjects, 0);
  assert.equal(report.counts.visibleMetadataBlockerObjects, 2);
  assert.equal(report.blockerReasonCounts.missing_account_control, 1);
  assert.equal(report.blockerReasonCounts.account_deletion_pending, 1);
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.objectFingerprint?.startsWith('hmac-sha256:') &&
        finding.reasons.includes('missing_account_control'),
    ),
  );
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.objectFingerprint?.startsWith('hmac-sha256:') &&
        finding.reasons.includes('account_deletion_pending'),
    ),
  );
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(USER_ONE), false);
  assert.equal(serialized.includes(USER_TWO), false);
});

test('bucket configuration preflight fails closed before any inventory reads', async () => {
  const exact = {
    id: AVATAR_BUCKET,
    name: AVATAR_BUCKET,
    public: false,
    file_size_limit: AVATAR_FILE_SIZE_LIMIT_BYTES,
    allowed_mime_types: ['image/webp'],
  };
  const cases = [
    { data: { ...exact, public: true }, code: 'STORAGE_BUCKET_CONFIGURATION_DRIFT' },
    {
      data: { ...exact, file_size_limit: AVATAR_FILE_SIZE_LIMIT_BYTES + 1 },
      code: 'STORAGE_BUCKET_CONFIGURATION_DRIFT',
    },
    {
      data: { ...exact, allowed_mime_types: ['image/webp', 'image/png'] },
      code: 'STORAGE_BUCKET_CONFIGURATION_DRIFT',
    },
    {
      data: { ...exact, file_size_limit: String(AVATAR_FILE_SIZE_LIMIT_BYTES) },
      code: 'STORAGE_BUCKET_CONFIGURATION_MALFORMED',
    },
  ];

  for (const candidate of cases) {
    const mocked = mockClient({ ...inventoryFixture(), bucketData: candidate.data });
    await assert.rejects(
      runVisibleInventory({
        client: mocked.client,
        config: validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory'),
        evidenceSalt: Buffer.from('bucket-preflight-test-salt-material-32-bytes', 'utf8'),
      }),
      (error) => error.code === candidate.code,
    );
    assert.deepEqual(mocked.calls.bucketReads, [AVATAR_BUCKET]);
    assert.deepEqual(mocked.calls.authPages, []);
    assert.deepEqual(mocked.calls.profileRanges, []);
    assert.deepEqual(mocked.calls.accountControlRanges, []);
    assert.deepEqual(mocked.calls.lists, []);
  }
});

test('zero and over-limit visible sizes block inventory and backup before download', async () => {
  const fixture = {
    users: [{ id: USER_ONE }, { id: USER_TWO }],
    profiles: [
      { id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' },
      { id: USER_TWO, avatar_updated_at: '2026-08-13T02:00:00.000Z' },
    ],
    accountControls: [
      { user_id: USER_ONE, deletion_pending: false },
      { user_id: USER_TWO, deletion_pending: false },
    ],
    tree: new Map([
      ['', [folder(USER_ONE), folder(USER_TWO)]],
      [USER_ONE, [object('avatar.webp', 0)]],
      [USER_TWO, [object('avatar.webp', AVATAR_FILE_SIZE_LIMIT_BYTES + 1)]],
    ]),
    downloads: new Map([
      [`${USER_ONE}/avatar.webp`, Buffer.alloc(0)],
      [`${USER_TWO}/avatar.webp`, Buffer.alloc(AVATAR_FILE_SIZE_LIMIT_BYTES + 1)],
    ]),
  };
  const inventoryMock = mockClient(fixture);
  const report = await runVisibleInventory({
    client: inventoryMock.client,
    config: validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory'),
    evidenceSalt: Buffer.from('visible-size-boundary-test-salt-material', 'utf8'),
    now: () => FIXED_NOW,
  });
  assert.equal(report.counts.eligibleForBackfillObjects, 0);
  assert.equal(report.counts.visibleMetadataBlockerObjects, 2);
  assert.equal(report.blockerReasonCounts.visible_byte_size_out_of_range, 2);
  assert.ok(
    report.findings
      .filter((finding) => finding.reasons.includes('visible_byte_size_out_of_range'))
      .every((finding) => finding.objectFingerprint?.startsWith('hmac-sha256:')),
  );
  assert.deepEqual(inventoryMock.calls.downloads, []);

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-avatar-size-gate-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const backupMock = mockClient(fixture);
  try {
    await assert.rejects(
      runAvatarBackup({
        client: backupMock.client,
        config: validateOperatorConfig(rawConfig('avatar-backup'), 'avatar-backup'),
        archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
        outputDirectory,
        repositoryRoot,
        now: () => FIXED_NOW,
      }),
      (error) => error.code === 'VISIBLE_METADATA_BLOCKERS_PRESENT',
    );
    assert.deepEqual(backupMock.calls.downloads, []);
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('remote failures are reduced to stable codes without raw identifiers', async () => {
  const config = validateOperatorConfig(rawConfig('visible-inventory'), 'visible-inventory');
  const rawSecret = `${USER_ONE}/avatar.webp private-one@example.test`;
  const fixture = inventoryFixture();
  const { client } = mockClient(fixture);
  client.auth.admin.listUsers = async () => ({ data: null, error: { message: rawSecret } });
  await assert.rejects(
    runVisibleInventory({
      client,
      config,
      evidenceSalt: Buffer.from('inventory-test-salt-material-at-least-32-bytes'),
    }),
    (error) => {
      assert.equal(error.code, 'AUTH_USERS_LIST_FAILED');
      assert.equal(error.message.includes(rawSecret), false);
      return true;
    },
  );
});

test('visible evidence writer requires a new absolute file inside the repository', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-visible-evidence-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outside = path.join(sandbox, 'outside');
  await Promise.all([mkdir(repositoryRoot), mkdir(outside)]);
  const report = { kind: 'aggregate-only', counts: { visibleObjects: 0 } };
  const file = path.join(repositoryRoot, 'visible-inventory.json');
  try {
    await writeInventoryReport(file, report, repositoryRoot);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), report);
    await assert.rejects(
      writeInventoryReport(file, report, repositoryRoot),
      (error) => error.code === 'INVENTORY_OUTPUT_WRITE_FAILED',
    );
    await assert.rejects(
      writeInventoryReport(path.join(outside, 'evidence.json'), report, repositoryRoot),
      (error) => error.code === 'INVENTORY_OUTPUT_OUTSIDE_REPOSITORY',
    );
    await assert.rejects(
      writeInventoryReport('relative-evidence.json', report, repositoryRoot),
      (error) => error.code === 'INVENTORY_OUTPUT_PATH_MUST_BE_ABSOLUTE',
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('private backup encrypts manifest and tar, verifies bytes, and leaves only a safe receipt', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-avatar-backup-test-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const avatarBytes = Buffer.from('mock-webp-byte-payload-for-verification', 'utf8');
  const key = `${USER_ONE}/avatar.webp`;
  const fixture = {
    users: [{ id: USER_ONE, email: 'never-write@example.test' }],
    profiles: [{ id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' }],
    accountControls: [{ user_id: USER_ONE, deletion_pending: false }],
    tree: new Map([
      ['', [folder(USER_ONE)]],
      [
        USER_ONE,
        [object('avatar.webp', avatarBytes.length, { metadata: { etag: 'private-etag' } })],
      ],
    ]),
    downloads: new Map([[key, avatarBytes]]),
    streamDownloads: true,
  };
  const mocked = mockClient(fixture);
  const config = validateOperatorConfig(rawConfig('avatar-backup'), 'avatar-backup');

  try {
    const receipt = await runAvatarBackup({
      client: mocked.client,
      config,
      archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
      outputDirectory,
      repositoryRoot,
      now: () => FIXED_NOW,
    });
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.archivedObjects, 1);
    assert.equal(receipt.archivedBytes, avatarBytes.length);
    assert.equal(receipt.archiveVerified, true);
    assert.equal(receipt.manifestVerified, true);
    assert.equal(receipt.physicalBackendOrVersionInventoryPerformed, false);
    assert.equal(receipt.backendPhysicalOrVersionVerdict, 'not-assessed');
    assert.deepEqual(mocked.calls.downloads, [key]);

    const runDirectories = await readdir(outputDirectory);
    assert.deepEqual(runDirectories, [receipt.runDirectoryName]);
    const runDirectory = path.join(outputDirectory, receipt.runDirectoryName);
    const files = (await readdir(runDirectory)).sort();
    assert.deepEqual(files, ['avatars.tar.aes256gcm', 'manifest.json.aes256gcm', 'receipt.json']);
    const [archive, encryptedManifest, diskReceipt] = await Promise.all([
      readFile(path.join(runDirectory, 'avatars.tar.aes256gcm')),
      readFile(path.join(runDirectory, 'manifest.json.aes256gcm')),
      readFile(path.join(runDirectory, 'receipt.json'), 'utf8'),
    ]);
    for (const sensitive of [USER_ONE, key, 'never-write@example.test', 'private-etag']) {
      assert.equal(archive.includes(Buffer.from(sensitive)), false);
      assert.equal(encryptedManifest.includes(Buffer.from(sensitive)), false);
      assert.equal(diskReceipt.includes(sensitive), false);
    }
    assert.equal(archive.includes(avatarBytes), false);
    assert.equal(encryptedManifest.subarray(0, 23).toString('ascii'), 'SAFETYHUB-ENCRYPTED-V1\n');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('forensic backup preserves every bounded visible object without authorizing deletion', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-avatar-forensic-test-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const legacyBytes = Buffer.from('legacy-avatar-forensic-bytes', 'utf8');
  const immutableBytes = Buffer.from('immutable-avatar-forensic-bytes', 'utf8');
  const legacyKey = `${USER_ONE}/avatar.webp`;
  const immutableKey = `${USER_ONE}/objects/${OPERATION_TOKEN}.webp`;
  const fixture = {
    users: [{ id: USER_ONE, email: 'never-write@example.test' }],
    profiles: [{ id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' }],
    accountControls: [{ user_id: USER_ONE, deletion_pending: false }],
    tree: new Map([
      ['', [folder(USER_ONE)]],
      [
        USER_ONE,
        [object('avatar.webp', legacyBytes.length), folder('objects')],
      ],
      [
        `${USER_ONE}/objects`,
        [object(`${OPERATION_TOKEN}.webp`, immutableBytes.length)],
      ],
    ]),
    downloads: new Map([
      [legacyKey, legacyBytes],
      [immutableKey, immutableBytes],
    ]),
  };
  const mocked = mockClient(fixture);
  const config = validateOperatorConfig(
    rawConfig('avatar-backup', {
      classificationMode: 'visible-metadata-forensic-backup',
      backupBlockedVisibleObjects: true,
    }),
    'avatar-backup',
  );

  try {
    const receipt = await runAvatarBackup({
      client: mocked.client,
      config,
      archivePassphrase: 'test-only-forensic-passphrase-with-more-than-32-bytes',
      outputDirectory,
      repositoryRoot,
      now: () => FIXED_NOW,
    });
    assert.equal(receipt.archivedObjects, 2);
    assert.equal(receipt.archivedBytes, legacyBytes.length + immutableBytes.length);
    assert.deepEqual(mocked.calls.downloads.sort(), [immutableKey, legacyKey].sort());
    assert.deepEqual((await readdir(path.join(outputDirectory, receipt.runDirectoryName))).sort(), [
      'avatars.tar.aes256gcm',
      'manifest.json.aes256gcm',
      'receipt.json',
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('backup hard-fails on byte-size mismatch and removes its incomplete run', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-avatar-backup-size-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const key = `${USER_ONE}/avatar.webp`;
  const fixture = {
    users: [{ id: USER_ONE }],
    profiles: [{ id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' }],
    accountControls: [{ user_id: USER_ONE, deletion_pending: false }],
    tree: new Map([
      ['', [folder(USER_ONE)]],
      [USER_ONE, [object('avatar.webp', 999)]],
    ]),
    downloads: new Map([[key, Buffer.from('short')]]),
  };
  try {
    await assert.rejects(
      runAvatarBackup({
        client: mockClient(fixture).client,
        config: validateOperatorConfig(rawConfig('avatar-backup'), 'avatar-backup'),
        archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
        outputDirectory,
        repositoryRoot,
        now: () => FIXED_NOW,
      }),
      (error) => error.code === 'STORAGE_DOWNLOAD_SIZE_MISMATCH',
    );
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('backup refuses a canonical avatar with a missing or deletion-pending control', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-avatar-backup-control-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const outputDirectory = path.join(sandbox, 'private-output');
  await Promise.all([mkdir(repositoryRoot), mkdir(outputDirectory)]);
  const key = `${USER_ONE}/avatar.webp`;
  try {
    for (const accountControls of [[], [{ user_id: USER_ONE, deletion_pending: true }]]) {
      const mocked = mockClient({
        users: [{ id: USER_ONE }],
        profiles: [{ id: USER_ONE, avatar_updated_at: '2026-08-13T01:00:00.000Z' }],
        accountControls,
        tree: new Map([
          ['', [folder(USER_ONE)]],
          [USER_ONE, [object('avatar.webp', 3)]],
        ]),
        downloads: new Map([[key, Buffer.from('abc')]]),
      });
      await assert.rejects(
        runAvatarBackup({
          client: mocked.client,
          config: validateOperatorConfig(rawConfig('avatar-backup'), 'avatar-backup'),
          archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
          outputDirectory,
          repositoryRoot,
          now: () => FIXED_NOW,
        }),
        (error) => error.code === 'VISIBLE_METADATA_BLOCKERS_PRESENT',
      );
      assert.deepEqual(mocked.calls.downloads, []);
    }
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('backup rejects repository output and visible blockers before any download', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-avatar-backup-gates-'));
  const repositoryRoot = path.join(sandbox, 'repository');
  const insideRepository = path.join(repositoryRoot, 'private-output');
  const outsideRepository = path.join(sandbox, 'outside-output');
  await mkdir(insideRepository, { recursive: true });
  await mkdir(outsideRepository);
  const config = validateOperatorConfig(rawConfig('avatar-backup'), 'avatar-backup');
  const fixture = inventoryFixture();
  const insideMock = mockClient(fixture);
  try {
    await assert.rejects(
      runAvatarBackup({
        client: insideMock.client,
        config,
        archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
        outputDirectory: insideRepository,
        repositoryRoot,
      }),
      (error) => error.code === 'OUTPUT_DIRECTORY_INSIDE_REPOSITORY',
    );
    assert.deepEqual(insideMock.calls.authPages, []);

    await assert.rejects(
      runAvatarBackup({
        client: insideMock.client,
        config,
        archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
        outputDirectory: sandbox,
        repositoryRoot,
      }),
      (error) => error.code === 'OUTPUT_DIRECTORY_ANCESTOR_OF_REPOSITORY',
    );
    assert.deepEqual(insideMock.calls.authPages, []);

    const blockerMock = mockClient(fixture);
    await assert.rejects(
      runAvatarBackup({
        client: blockerMock.client,
        config,
        archivePassphrase: 'test-only-archive-passphrase-with-more-than-32-bytes',
        outputDirectory: outsideRepository,
        repositoryRoot,
      }),
      (error) => error.code === 'VISIBLE_METADATA_BLOCKERS_PRESENT',
    );
    assert.deepEqual(blockerMock.calls.downloads, []);
    assert.deepEqual(await readdir(outsideRepository), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('operator tooling contains no Storage mutation or physical-backend claim path', async () => {
  const source = await readFile(
    new URL('../../scripts/storage-operator-tools.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\b(?:storage|bucket)\.(?:remove|upload|update|move|copy)\s*\(/u);
  assert.doesNotMatch(source, /['"`]storage\.objects['"`]|ObjectAdminDelete|backend scanner/iu);
  assert.match(source, /physicalBackendOrVersionInventoryPerformed:\s*false/u);
  assert.match(source, /backendPhysicalOrVersionVerdict:\s*'not-assessed'/u);
});
