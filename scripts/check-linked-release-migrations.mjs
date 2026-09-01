import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentProductionProjectRef,
  assertLinkedProductionProjectRef,
} from './production-operator-safety.mjs';

const MIGRATION_VERSION = /^[0-9]{14}$/u;
const MIGRATION_FILENAME = /^([0-9]{14})_([a-z0-9_]+)[.]sql$/u;
const MAX_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;

// This is an explicit approval record for the *unapplied* RU/KK/EN/ZH release
// delta, not a generic migration policy. A newly reviewed migration must be
// added here (with its normalized hash and corresponding tests) before it can
// be applied; accepting an open-ended local tail would defeat this preflight.
export const REVIEWED_BASE_MIGRATION_COUNT = 39;
export const REVIEWED_PENDING_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: '20260901100000_locale_profile_legal_contracts.sql',
    sha256: '5b07cd3e7784c6d33993879905e24a012c40397a5e46fed991fb0d7c37da5ce4',
  }),
  Object.freeze({
    filename: '20260901101000_localized_content_tables.sql',
    sha256: 'a39f0fb3e7c055299827e1120d132bf899f38fddb42986a27f61b581e6d3edf2',
  }),
  Object.freeze({
    filename: '20260901102000_localized_course_publication_reads.sql',
    sha256: '032ade2af4a60febe82f0d995d65c387eec5d4a691d23b7eaa29d7c26c845699',
  }),
  Object.freeze({
    filename: '20260901102500_localized_article_legal_publication_reads.sql',
    sha256: '7adff3230de440c1c4ce8134531af2496538119041f66f91c52cbea8ecbc10ed',
  }),
  Object.freeze({
    filename: '20260901103000_zh_webauthn_auth.sql',
    sha256: 'bdcb02d52c3a107a23203715156facfde6c74ac8b0f59d1560f57527363b5c15',
  }),
  Object.freeze({
    filename: '20260901103500_zh_session_epoch_enforcement.sql',
    sha256: '7fe0749100fd693a1c844c33d1b229c466b65494cd85aeb6209d84b8483a1d8f',
  }),
  Object.freeze({
    filename: '20260901105000_attempt_certificate_locale_contract.sql',
    sha256: '7497c4cb5e8b042ab97f8de15a240917d0a7f67849e84343d18d776cdee9e74c',
  }),
  Object.freeze({
    filename: '20260901106000_transactional_notification_inbox.sql',
    sha256: '7b7d1d520f61835b72b8f60379dc168271ce41cd68ecb20da19613ef0a09baf4',
  }),
  Object.freeze({
    filename: '20260901107000_runtime_rollout_flags.sql',
    sha256: 'aaf6ad13690683b0a05c5f8fb4bfd8d47a76084dd5dd904dddbf701ebb0da045',
  }),
  Object.freeze({
    filename: '20260901108000_security_boundary_hardening.sql',
    sha256: '4ae63a24195509a7f6b55a61588a49989f1d71d0d885f59f754e7260c13ede17',
  }),
  Object.freeze({
    filename: '20260901109000_notification_dispatch_vault_operator.sql',
    sha256: 'edc95a50435b16101b05247c15fba2c378054b03e4874dba126eb48582a1067c',
  }),
  Object.freeze({
    filename: '20260901109100_zh_avatar_storage_write_guard.sql',
    sha256: '0959c578bf8aaf14e27662e1180375cb62125d9cf11853574f8561e6e4092c4e',
  }),
  Object.freeze({
    filename: '20260901109200_runtime_trigger_flag_boundary.sql',
    sha256: 'd6aad8fb21b63d54d67adc7ed18b9dcb4832f84f9b2475a54ccc02a7f75d9017',
  }),
  Object.freeze({
    filename: '20260901109300_zh_otp_session_grant_provider_contract.sql',
    sha256: 'ded67cd0c129fd441750c865f06b1b8468b2977102dbffd1d636dee7d5e02f48',
  }),
  Object.freeze({
    filename: '20260902110000_capacity_telegram_application_details.sql',
    sha256: '2549e9ad148336ab25eaa6a0ca19fc216d9c5b370df61fc08e26297e75d567df',
  }),
  Object.freeze({
    filename: '20260902130000_zh_username_password_auth.sql',
    sha256: '92cf8294543b40d1b9e950b69d75ea41e5be738d1e049fb9fbcfedeba929f5a1',
  }),
  Object.freeze({
    filename: '20260902140000_runtime_feature_flag_serialization.sql',
    sha256: '8f557b7e219bd631934d70bf8a3173a2caccb74b1f37db1b580cae987cd7d3dd',
  }),
]);
export const REVIEWED_TOTAL_MIGRATION_COUNT =
  REVIEWED_BASE_MIGRATION_COUNT + REVIEWED_PENDING_MIGRATIONS.length;

export class LinkedMigrationPreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LinkedMigrationPreflightError';
    this.code = code;
  }
}

function fail(code) {
  throw new LinkedMigrationPreflightError(code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedMigrationHash(source) {
  return sha256(Buffer.from(source.replaceAll('\r\n', '\n'), 'utf8'));
}

function versionFromFilename(filename) {
  if (typeof filename !== 'string') fail('LINKED_PREFLIGHT_LOCAL_MIGRATION_FILENAME_INVALID');
  const match = filename.match(MIGRATION_FILENAME);
  if (!match) fail('LINKED_PREFLIGHT_LOCAL_MIGRATION_FILENAME_INVALID');
  return match[1];
}

export async function loadLocalMigrationInventory(
  migrationDirectory = path.resolve('supabase', 'migrations'),
) {
  let entries;
  try {
    entries = await readdir(migrationDirectory, { withFileTypes: true });
  } catch {
    fail('LINKED_PREFLIGHT_LOCAL_MIGRATIONS_UNAVAILABLE');
  }
  const sqlEntries = entries.filter((entry) => entry.name.endsWith('.sql'));
  if (sqlEntries.some((entry) => !entry.isFile())) {
    fail('LINKED_PREFLIGHT_LOCAL_MIGRATION_FILE_INVALID');
  }
  const filenames = sqlEntries
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const inventory = [];
  for (const filename of filenames) {
    const version = versionFromFilename(filename);
    const source = await readFile(path.join(migrationDirectory, filename), 'utf8').catch(() => {
      fail('LINKED_PREFLIGHT_LOCAL_MIGRATION_UNAVAILABLE');
    });
    inventory.push({ filename, version, sha256: normalizedMigrationHash(source) });
  }
  if (
    inventory.length === 0 ||
    new Set(inventory.map(({ version }) => version)).size !== inventory.length
  ) {
    fail('LINKED_PREFLIGHT_LOCAL_MIGRATION_HISTORY_INVALID');
  }
  return inventory;
}

export function parseLinkedMigrationList(serialized) {
  if (
    typeof serialized !== 'string' ||
    serialized.length === 0 ||
    Buffer.byteLength(serialized, 'utf8') > MAX_CLI_OUTPUT_BYTES
  ) {
    fail('LINKED_PREFLIGHT_CLI_OUTPUT_INVALID');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    fail('LINKED_PREFLIGHT_CLI_OUTPUT_INVALID');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.migrations)) {
    fail('LINKED_PREFLIGHT_CLI_OUTPUT_INVALID');
  }
  return payload.migrations.map((row) => {
    if (!row || typeof row !== 'object') fail('LINKED_PREFLIGHT_CLI_OUTPUT_INVALID');
    const local = row.local === undefined || row.local === null ? '' : String(row.local);
    const remote = row.remote === undefined || row.remote === null ? '' : String(row.remote);
    if (
      (local !== '' && !MIGRATION_VERSION.test(local)) ||
      (remote !== '' && !MIGRATION_VERSION.test(remote)) ||
      (local === '' && remote === '')
    ) {
      fail('LINKED_PREFLIGHT_CLI_OUTPUT_INVALID');
    }
    return { local, remote };
  });
}

function sameOrderedValues(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function sameOrderedMigrationRows(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (row, index) => row.local === expected[index].local && row.remote === expected[index].remote,
    )
  );
}

function assertMigrationRows(migrationRows) {
  if (
    !Array.isArray(migrationRows) ||
    migrationRows.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        typeof row.local !== 'string' ||
        typeof row.remote !== 'string' ||
        (row.local !== '' && !MIGRATION_VERSION.test(row.local)) ||
        (row.remote !== '' && !MIGRATION_VERSION.test(row.remote)) ||
        (row.local === '' && row.remote === ''),
    )
  ) {
    fail('LINKED_PREFLIGHT_INPUT_INVALID');
  }
}

export function assertReviewedLocalMigrationInventory(localMigrations) {
  if (!Array.isArray(localMigrations) || localMigrations.length === 0) {
    fail('LINKED_PREFLIGHT_INPUT_INVALID');
  }
  const localVersions = localMigrations.map((migration) => migration?.version);
  if (
    localMigrations.some(
      (migration) =>
        !migration ||
        typeof migration.filename !== 'string' ||
        !MIGRATION_VERSION.test(migration.version) ||
        !/^[0-9a-f]{64}$/u.test(migration.sha256) ||
        versionFromFilename(migration.filename) !== migration.version,
    ) ||
    new Set(localVersions).size !== localVersions.length
  ) {
    fail('LINKED_PREFLIGHT_LOCAL_MIGRATION_HISTORY_INVALID');
  }
  if (localMigrations.length !== REVIEWED_TOTAL_MIGRATION_COUNT) {
    fail('LINKED_PREFLIGHT_PENDING_SET_MISMATCH');
  }
  const pendingInventory = localMigrations.slice(REVIEWED_BASE_MIGRATION_COUNT);
  if (pendingInventory.length !== REVIEWED_PENDING_MIGRATIONS.length) {
    fail('LINKED_PREFLIGHT_PENDING_SET_MISMATCH');
  }
  for (const [index, expected] of REVIEWED_PENDING_MIGRATIONS.entries()) {
    const actual = pendingInventory[index];
    if (actual.filename !== expected.filename || actual.sha256 !== expected.sha256) {
      fail('LINKED_PREFLIGHT_REVIEWED_MIGRATION_HASH_MISMATCH');
    }
  }
  return localVersions;
}

export function assertReviewedMigrationDelta({ migrationRows, localMigrations }) {
  const localVersions = assertReviewedLocalMigrationInventory(localMigrations);
  assertMigrationRows(migrationRows);
  const listedLocalVersions = migrationRows
    .filter(({ local }) => local !== '')
    .map(({ local }) => local);
  if (!sameOrderedValues(listedLocalVersions, localVersions)) {
    fail('LINKED_PREFLIGHT_LOCAL_HISTORY_MISMATCH');
  }
  if (migrationRows.some(({ local, remote }) => remote !== '' && local !== remote)) {
    fail('LINKED_PREFLIGHT_REMOTE_ONLY_OR_MISMATCHED');
  }
  const remoteVersions = migrationRows
    .filter(({ remote }) => remote !== '')
    .map(({ remote }) => remote);
  if (
    remoteVersions.length !== REVIEWED_BASE_MIGRATION_COUNT ||
    !sameOrderedValues(remoteVersions, localVersions.slice(0, REVIEWED_BASE_MIGRATION_COUNT))
  ) {
    fail('LINKED_PREFLIGHT_HOSTED_HISTORY_NOT_REVIEWED_PREFIX');
  }
  const expectedPendingVersions = REVIEWED_PENDING_MIGRATIONS.map(({ filename }) =>
    versionFromFilename(filename),
  );
  const pendingVersions = migrationRows
    .filter(({ remote }) => remote === '')
    .map(({ local }) => local);
  if (!sameOrderedValues(pendingVersions, expectedPendingVersions)) {
    fail('LINKED_PREFLIGHT_PENDING_SET_MISMATCH');
  }
  const expectedRows = [
    ...localVersions.slice(0, REVIEWED_BASE_MIGRATION_COUNT).map((version) => ({
      local: version,
      remote: version,
    })),
    ...expectedPendingVersions.map((version) => ({ local: version, remote: '' })),
  ];
  if (!sameOrderedMigrationRows(migrationRows, expectedRows)) {
    fail('LINKED_PREFLIGHT_HISTORY_SHAPE_MISMATCH');
  }
  const reviewedSetSha256 = sha256(
    Buffer.from(
      REVIEWED_PENDING_MIGRATIONS.map(
        ({ filename, sha256: migrationSha256 }) => `${filename}:${migrationSha256}`,
      ).join('\n'),
      'utf8',
    ),
  );
  return Object.freeze({
    ok: true,
    mode: 'pre-migration-reviewed-delta',
    matchedCount: remoteVersions.length,
    pendingCount: pendingVersions.length,
    expectedBaseCount: REVIEWED_BASE_MIGRATION_COUNT,
    expectedPendingCount: REVIEWED_PENDING_MIGRATIONS.length,
    expectedTotalCount: REVIEWED_TOTAL_MIGRATION_COUNT,
    pendingMigrations: REVIEWED_PENDING_MIGRATIONS.map(({ filename }) => filename),
    reviewedSetSha256,
  });
}

function expectedProjectRefArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--expected-project-ref' || !argv[1]) {
    fail('LINKED_PREFLIGHT_USAGE_INVALID');
  }
  return argv[1];
}

export async function main(argv = process.argv.slice(2)) {
  const expectedProjectRef = assertCurrentProductionProjectRef(expectedProjectRefArgument(argv));
  const localMigrations = await loadLocalMigrationInventory();
  assertReviewedLocalMigrationInventory(localMigrations);
  await assertLinkedProductionProjectRef(expectedProjectRef);
  const cli = path.resolve('node_modules', 'supabase', 'dist', 'supabase.js');
  const result = spawnSync(
    process.execPath,
    [cli, 'migration', 'list', '--linked', '--output-format', 'json'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3 * 60 * 1000,
      maxBuffer: MAX_CLI_OUTPUT_BYTES,
    },
  );
  if (result.error || result.status !== 0) fail('LINKED_PREFLIGHT_MIGRATION_LIST_FAILED');
  await assertLinkedProductionProjectRef(expectedProjectRef);
  const migrationRows = parseLinkedMigrationList(result.stdout);
  const receipt = assertReviewedMigrationDelta({ migrationRows, localMigrations });
  console.log(JSON.stringify({ ...receipt, projectRef: expectedProjectRef }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof LinkedMigrationPreflightError || typeof error?.code === 'string'
        ? error.code
        : 'LINKED_PREFLIGHT_FAILED',
    );
    process.exitCode = 1;
  });
}
