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

// This is an explicit approval record for the post-localization forward delta,
// not a generic migration policy. Production holds the reviewed base;
// issuance and selection recovery form the exact hash-pinned pending tail. Adding
// a migration means adding it here too, with its hash; an open-ended local tail
// would defeat this preflight.
export const REVIEWED_BASE_MIGRATION_COUNT = 103;
export const REVIEWED_APPLIED_RELEASE_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: '20260909101000_organization_search_wildcard_escape.sql',
    sha256: '2452256c6cf5dec6695375b341939090eca40a750e8925f40fe21c0cd2d31910',
  }),
  Object.freeze({
    filename: '20260909110000_article_listing_page_size.sql',
    sha256: '75a7da5b4e1ac19a5bfc40a5c2d479271baa4d026db3719e75565260a20b4657',
  }),
  Object.freeze({
    filename: '20260909120000_audit_product_role_changes.sql',
    sha256: '454cba0c0338e19c7d5255cfd6516e533160eb9b9d19161047b080e2c19a0191',
  }),
  Object.freeze({
    filename: '20260912100000_immediate_self_account_purge.sql',
    sha256: 'c591faa13edc838492c12605781c4daa07a82b888c77891c94fa90ba50f0d91b',
  }),
  Object.freeze({
    filename: '20260912130000_course_access_grants.sql',
    sha256: 'ff2f5a3ae020414be1d2b4e0df4a334772785e6710e788361aeabc14a32bf71a',
  }),
  Object.freeze({
    filename: '20260912170000_certificate_settings_and_purge_receipts.sql',
    sha256: 'dde05d00b28521c7c857be471a65cdaa12daf39844bfe36fa408e9149212a866',
  }),
  Object.freeze({
    filename: '20260912180000_admin_reads_and_schedules.sql',
    sha256: 'd4ef996f9e1218864267a9ab2b1c801fd3cbad778aa43d4f97e2f45e67349824',
  }),
  Object.freeze({
    filename: '20260912182000_auth_email_outbox_and_otp_gateway.sql',
    sha256: '91893b9e12ea5926bbde47096f52464ae9e1c2c680f98cbd3d4c1c9aa4219520',
  }),
  Object.freeze({
    filename: '20260915120000_document_editor.sql',
    sha256: 'c529f831c4cfd4f7723cc621909eedc8b38136bf28817452c9d307f03105d6be',
  }),
  Object.freeze({
    filename: '20260915180000_document_insert_and_education.sql',
    sha256: '171eb16acbc064119b2fd8905e41d6a1e424b457738e91c7670338f7edc08315',
  }),
  Object.freeze({
    filename: '20260915190000_education_durable_quota.sql',
    sha256: 'e883aea122538333e90eceac6548d853a339c7da40086ebecc8f147983f9a29b',
  }),
  Object.freeze({
    filename: '20260917120000_document_facsimiles.sql',
    sha256: '9f4b898891325a0f42684a27941a8ac6b2dfb6168756fbd468dd299327d6e679',
  }),
  Object.freeze({
    filename: '20260919120000_document_profiles_and_snapshots.sql',
    sha256: '686f3e53ae748a0aadeb253078a54eeef945343aa4cbceddeab8244fac48d9b3',
  }),
  Object.freeze({
    filename: '20260919121000_document_required_fields.sql',
    sha256: '78995896e5fa4b13f7a3f7dcb3476d5af2fccf7148e1f5816a457efc720d9fbc',
  }),
  Object.freeze({
    filename: '20260919122000_industrial_formal_exam_evidence.sql',
    sha256: '9eb90a001c681f34fbfa7238542e8fe004d8af84859954fe44f68655ff5eba35',
  }),
  Object.freeze({
    filename: '20260919140000_new_issuance_education.sql',
    sha256: '757f22ea6ec52d614073d933ddeafd6015cb37677e191bbf56df6179dc364afb',
  }),
  Object.freeze({
    filename: '20260919141000_preserve_training_on_education_refusal.sql',
    sha256: '970c0b773373d5c2f5a5323d3802d17a6d143102d9a309553836a167202e1efe',
  }),
  Object.freeze({
    filename: '20260919142000_refresh_selected_attestation_summary.sql',
    sha256: 'd26847294d29ae771405d12594f1a26dd77ab87fe10ac93e3d79680ea2491863',
  }),
  Object.freeze({
    filename: '20260920100000_document_assets_immutable.sql',
    sha256: '382d6d093a805acdb25d03c699ae85372fd03ee5b80c2b64234a2c4495c4db80',
  }),
  Object.freeze({
    filename: '20260920120000_recapture_legacy_cutover_profiles.sql',
    sha256: 'd943c48ed47ab54e7c1493fa212ec9118417c83735149e7df6f7d455bc5f0741',
  }),
  Object.freeze({
    filename: '20260920140000_purge_clears_article_publisher.sql',
    sha256: '17fbb2df8e2564e173ef5a866b8b125170370a912c036153b304994a0cac9e7c',
  }),
  Object.freeze({
    filename: '20260920150000_purge_clears_remaining_user_references.sql',
    sha256: '3cff6de8af824e984776b42896563090d72d225df1dc1be4ddb0104e4451ea13',
  }),
  Object.freeze({
    filename: '20260920160000_profile_education_required.sql',
    sha256: '538692d0f3e26d178eb60533c79f38f79d57405506979c75532aa094997b7ea1',
  }),
  Object.freeze({
    filename: '20260920170000_document_defaults_one_click.sql',
    sha256: '20875cdcb8c89f05ab675275365c637977110660ed2f3abfcd6fc9e57183216c',
  }),
  Object.freeze({
    filename: '20260920180000_protocol_note_always_empty.sql',
    sha256: 'c376563c903608d765b6d53c923c631acb1a47cb51eea6678fd6ad4636c5f466',
  }),
  Object.freeze({
    filename: '20260920190000_protocol_note_stays_writable.sql',
    sha256: '6940a3f254632e89860de20dc8ad5dcc4d246d3199c4f8596bdeeb090847b48e',
  }),
  Object.freeze({
    filename: '20260921100000_education_levels_and_protocol_parts.sql',
    sha256: '55951700609235cafb6eed5f1a482bd6f4c2a10cb34f43484e20c9410f298c15',
  }),
]);
export const REVIEWED_PENDING_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: '20260921120000_course_access_requests.sql',
    sha256: '1764ab557fc6abd4a6c10ced5986a18d79a1f507777bca635c2f359a3043d62f',
  }),
]);
export const REVIEWED_TOTAL_MIGRATION_COUNT =
  REVIEWED_BASE_MIGRATION_COUNT + REVIEWED_PENDING_MIGRATIONS.length;
const REVIEWED_APPLIED_RELEASE_START_INDEX =
  REVIEWED_BASE_MIGRATION_COUNT - REVIEWED_APPLIED_RELEASE_MIGRATIONS.length;

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
  if (REVIEWED_APPLIED_RELEASE_START_INDEX < 0) {
    fail('LINKED_PREFLIGHT_PENDING_SET_MISMATCH');
  }
  const appliedReleaseInventory = localMigrations.slice(
    REVIEWED_APPLIED_RELEASE_START_INDEX,
    REVIEWED_BASE_MIGRATION_COUNT,
  );
  if (appliedReleaseInventory.length !== REVIEWED_APPLIED_RELEASE_MIGRATIONS.length) {
    fail('LINKED_PREFLIGHT_PENDING_SET_MISMATCH');
  }
  for (const [index, expected] of REVIEWED_APPLIED_RELEASE_MIGRATIONS.entries()) {
    const actual = appliedReleaseInventory[index];
    if (actual.filename !== expected.filename || actual.sha256 !== expected.sha256) {
      fail('LINKED_PREFLIGHT_REVIEWED_MIGRATION_HASH_MISMATCH');
    }
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
