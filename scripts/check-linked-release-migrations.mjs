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
// not a generic migration policy. Production now holds every reviewed migration,
// so the pending tail is empty and the whole history is a pinned receipt. Adding
// a migration means adding it here too, with its hash; an open-ended local tail
// would defeat this preflight.
export const REVIEWED_BASE_MIGRATION_COUNT = 74;
export const REVIEWED_APPLIED_RELEASE_MIGRATIONS = Object.freeze([
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
  Object.freeze({
    filename: '20260902150000_zh_minimal_pending_approval.sql',
    sha256: '2713f7a95550821b8d0319b8d6b3cd979bd3ef1c82e253611dec9ea09e473e29',
  }),
  Object.freeze({
    filename: '20260902160000_atomic_legal_bundle_publication.sql',
    sha256: '51a34bf7d01e504dc1fa47a3c5ff71cd152d17c5eedc37352bc0245c3341034c',
  }),
  Object.freeze({
    filename: '20260902170000_auth_realm_locale_boundary.sql',
    sha256: '75c6af9450886b4be4abb0cf97b3baf68516a7c92e94df9a0f38a204b6fb53a5',
  }),
  Object.freeze({
    filename: '20260902180000_generic_approval_notifications.sql',
    sha256: 'dfe58bf11bad8c60c41b08a19b085a0b5ce2af5bb053a0717a14199a292be4d3',
  }),
  Object.freeze({
    filename: '20260903090000_course_editor_question_bank_read.sql',
    sha256: '424d69c17873a72b1a37c578b8f87176270a635ea20a18dad3a3902867d9c233',
  }),
  Object.freeze({
    filename: '20260903120000_zh_full_profile_admission.sql',
    sha256: '3395026046b965d87f711e195fb6b02dc854f4cf69ea022e5578024512a078a5',
  }),
  Object.freeze({
    filename: '20260903150000_restore_course_drafts_from_published_revisions.sql',
    sha256: 'ddabe6dd7f5460b4a979f1a45bfdaa2f5e7962bf572f951c4fe42d9327e1e1b9',
  }),
  Object.freeze({
    filename: '20260903180000_course_editor_quiet_bank_read.sql',
    sha256: '898c77fae1c943954bdb8173485aa95d78eda149300e8e68d709694579c01f93',
  }),
  Object.freeze({
    filename: '20260903200000_course_seo_fill_and_republish.sql',
    sha256: 'ccfeb07a4ec8a3c4dca484bab9e0d1d23bc65d4b664ea837aaa877e1f19f2382',
  }),
  Object.freeze({
    filename: '20260903220000_presentation_service_role_grant.sql',
    sha256: '74293956a2ab53f2758fcb9eddad6f9abba351bad3fae8e7c7107c8cdc3ef5f6',
  }),
  Object.freeze({
    filename: '20260905100000_immediate_admin_account_purge.sql',
    sha256: '90f9fbc139659a0a4d70c7ce67304b0fd03e481dd6528700c94e6f6196e50907',
  }),
  Object.freeze({
    filename: '20260905101000_deletion_pending_admin_read_filters.sql',
    sha256: 'fe4e9a23b12ba4f067c986b0e369ffc5cd4b6edcd03e1c0100e705b9c712d3e5',
  }),
  Object.freeze({
    filename: '20260905110000_product_role_assignment_by_email.sql',
    sha256: '5610b664fec6cfdb17c4de98ea95bc99019f67db052e2884f80d2129b30350f5',
  }),
  Object.freeze({
    filename: '20260905120000_retire_certificate_revocation_surface.sql',
    sha256: '1987b4ae86616837b166c6f7f13cb76ea5b7c84298c8b06f841355e444fbbb93',
  }),
  Object.freeze({
    filename: '20260905130000_distinguishable_certificate_issue_refusals.sql',
    sha256: '0b27d75f48ea6bacf95e4a96ce9648819300373f52c54de1c43363a54952d1a7',
  }),
  Object.freeze({
    filename: '20260905140000_audit_event_whitelist_and_retention.sql',
    sha256: '104a95972b6ef01c1a6c61d2ba1c85b17cfdc9f051b33bd99f4c43ff49da5d7f',
  }),
  Object.freeze({
    filename: '20260905150000_admin_inbox_capability_and_legacy_payloads.sql',
    sha256: 'd6f1d1cff502de8c30f8df6a6a64a3c0d237b158387815f78a553ced4eadb441',
  }),
  Object.freeze({
    filename: '20260905160000_confirm_and_issue_certificates.sql',
    sha256: 'ec1179eb7c49ae9d5737a4e57aca08f1505ce8d650e605d11e5df4e460f1dc0a',
  }),
]);
export const REVIEWED_PENDING_MIGRATIONS = Object.freeze([

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
