import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LEGACY_RU_CATALOG_CHECKSUM,
  LEGACY_RU_CONTENT_TOTALS,
  assertLegacyRuContentContract,
  classifyLocalizedSchema,
} from '../../scripts/content-localization/linked-preflight-contract.mjs';
import {
  REVIEWED_APPLIED_RELEASE_MIGRATIONS,
  REVIEWED_BASE_MIGRATION_COUNT,
  REVIEWED_PENDING_MIGRATIONS,
  REVIEWED_TOTAL_MIGRATION_COUNT,
  assertReviewedMigrationDelta,
  assertReviewedLocalMigrationInventory,
  loadLocalMigrationInventory,
  parseLinkedMigrationList,
} from '../../scripts/check-linked-release-migrations.mjs';

function localizedSchemaState(value) {
  return {
    appLocale: value,
    legalDocumentLocalizations: value,
    testRevisionLocalizations: value,
    testRevisionPresentations: value,
    testRevisionVariantLocalizations: value,
    articleRevisionLocalizations: value,
  };
}

function legacyCourses() {
  return Array.from({ length: 5 }, () => ({
    durationMinutes: 15,
    passScore: 7,
    attemptsPerCalendarDay: 8,
    resetTimezone: 'Asia/Oral',
    variants: Array.from({ length: 3 }, () => Array.from({ length: 10 }, () => 4)),
  }));
}

function exactLegacyContract(overrides = {}) {
  return {
    catalogChecksum: LEGACY_RU_CATALOG_CHECKSUM,
    localCatalogChecksum: LEGACY_RU_CATALOG_CHECKSUM,
    totals: {
      courseCount: 5,
      presentationCount: 5,
      presentationPageCount: 198,
      variantCount: 15,
      questionCount: 150,
      optionCount: 600,
      correctAnswerCount: 150,
    },
    articleCount: 10,
    courses: legacyCourses(),
    ...overrides,
  };
}

function migrationRows(localMigrations) {
  return localMigrations.map(({ version }, index) => ({
    local: version,
    remote: index < REVIEWED_BASE_MIGRATION_COUNT ? version : '',
  }));
}

test('localized schema classifier accepts only exact legacy or complete states', () => {
  assert.equal(classifyLocalizedSchema(localizedSchemaState(false)), 'legacy-ru');
  assert.equal(classifyLocalizedSchema(localizedSchemaState(true)), 'localized');
  assert.throws(
    () => classifyLocalizedSchema({ ...localizedSchemaState(false), appLocale: true }),
    /CONTENT_SCHEMA_PARTIALLY_APPLIED/u,
  );
  assert.throws(
    () => classifyLocalizedSchema({ ...localizedSchemaState(false), appLocale: null }),
    /CONTENT_SCHEMA_STATE_INVALID/u,
  );
});

test('legacy RU fallback pins checksum, exact totals and every 3 x 10 x 4 policy shape', () => {
  const receipt = assertLegacyRuContentContract(exactLegacyContract());
  assert.equal(receipt.catalogChecksum, LEGACY_RU_CATALOG_CHECKSUM);
  assert.deepEqual(receipt.totals, LEGACY_RU_CONTENT_TOTALS);
  assert.deepEqual(receipt.coursePolicy, {
    variantCount: 3,
    questionCount: 10,
    optionCount: 4,
    durationMinutes: 15,
    passScore: 7,
    attemptsPerCalendarDay: 8,
    resetTimezone: 'Asia/Oral',
  });

  assert.throws(
    () => assertLegacyRuContentContract(exactLegacyContract({ catalogChecksum: '0'.repeat(64) })),
    /LEGACY_RU_CATALOG_CHECKSUM_MISMATCH/u,
  );
  assert.throws(
    () =>
      assertLegacyRuContentContract(
        exactLegacyContract({ totals: { ...exactLegacyContract().totals, optionCount: 599 } }),
      ),
    /LEGACY_RU_OPTION_COUNT_MISMATCH/u,
  );
  const malformedCourses = legacyCourses();
  malformedCourses[0].variants[0][0] = 3;
  assert.throws(
    () => assertLegacyRuContentContract(exactLegacyContract({ courses: malformedCourses })),
    /LEGACY_RU_OPTION_SHAPE_MISMATCH/u,
  );
});

test('reviewed migration gate accepts only the exact hosted prefix and pinned reviewed tail', async () => {
  const inventory = await loadLocalMigrationInventory();
  const localMigrations = inventory;
  const rows = migrationRows(localMigrations);
  const receipt = assertReviewedMigrationDelta({ migrationRows: rows, localMigrations });
  assert.equal(REVIEWED_APPLIED_RELEASE_MIGRATIONS.length, 19);
  assert.equal(REVIEWED_PENDING_MIGRATIONS.length, 2);
  assert.equal(REVIEWED_TOTAL_MIGRATION_COUNT, 60);
  assert.equal(inventory.length, REVIEWED_TOTAL_MIGRATION_COUNT);
  assert.equal(localMigrations.length, REVIEWED_TOTAL_MIGRATION_COUNT);
  assert.equal(receipt.matchedCount, 58);
  assert.equal(receipt.pendingCount, 2);
  assert.equal(receipt.expectedBaseCount, 58);
  assert.equal(receipt.expectedPendingCount, 2);
  assert.equal(receipt.expectedTotalCount, 60);
  assert.deepEqual(
    receipt.pendingMigrations,
    REVIEWED_PENDING_MIGRATIONS.map(({ filename }) => filename),
  );
  assert.match(receipt.reviewedSetSha256, /^[0-9a-f]{64}$/u);

  const changedHash = structuredClone(localMigrations);
  changedHash.at(-1).sha256 = '0'.repeat(64);
  assert.throws(
    () => assertReviewedMigrationDelta({ migrationRows: rows, localMigrations: changedHash }),
    /LINKED_PREFLIGHT_REVIEWED_MIGRATION_HASH_MISMATCH/u,
  );

  const renamedTail = structuredClone(localMigrations);
  renamedTail.at(-1).filename = '20260902180000_renamed_reviewed_migration.sql';
  assert.throws(
    () => assertReviewedMigrationDelta({ migrationRows: rows, localMigrations: renamedTail }),
    /LINKED_PREFLIGHT_REVIEWED_MIGRATION_HASH_MISMATCH/u,
  );

  const partiallyApplied = structuredClone(rows);
  partiallyApplied[REVIEWED_BASE_MIGRATION_COUNT].remote =
    partiallyApplied[REVIEWED_BASE_MIGRATION_COUNT].local;
  assert.throws(
    () => assertReviewedMigrationDelta({ migrationRows: partiallyApplied, localMigrations }),
    /LINKED_PREFLIGHT_HOSTED_HISTORY_NOT_REVIEWED_PREFIX/u,
  );

  const remoteOnly = [...structuredClone(rows), { local: '', remote: '20260901999999' }];
  assert.throws(
    () => assertReviewedMigrationDelta({ migrationRows: remoteOnly, localMigrations }),
    /LINKED_PREFLIGHT_REMOTE_ONLY_OR_MISMATCHED/u,
  );

  assert.throws(
    () =>
      assertReviewedMigrationDelta({
        migrationRows: [{ local: 'not-a-migration', remote: '' }],
        localMigrations,
      }),
    /LINKED_PREFLIGHT_INPUT_INVALID/u,
  );

  const unreviewedLocalTail = [
    ...localMigrations,
    {
      filename: '20991231235959_unreviewed_forward_migration.sql',
      version: '20991231235959',
      sha256: '0'.repeat(64),
    },
  ];
  assert.throws(
    () => assertReviewedLocalMigrationInventory(unreviewedLocalTail),
    /LINKED_PREFLIGHT_PENDING_SET_MISMATCH/u,
  );
  assert.throws(
    () =>
      assertReviewedMigrationDelta({
        migrationRows: migrationRows(unreviewedLocalTail),
        localMigrations: unreviewedLocalTail,
      }),
    /LINKED_PREFLIGHT_PENDING_SET_MISMATCH/u,
  );
});

test('migration-list parser rejects malformed and unbounded CLI output', () => {
  assert.deepEqual(
    parseLinkedMigrationList(
      JSON.stringify({ migrations: [{ local: '20260813000000', remote: '20260813000000' }] }),
    ),
    [{ local: '20260813000000', remote: '20260813000000' }],
  );
  assert.throws(() => parseLinkedMigrationList('{'), /LINKED_PREFLIGHT_CLI_OUTPUT_INVALID/u);
  assert.throws(
    () => parseLinkedMigrationList(JSON.stringify({ migrations: [{ local: '', remote: '' }] })),
    /LINKED_PREFLIGHT_CLI_OUTPUT_INVALID/u,
  );
});

test('release scripts keep legacy fallback read-only and post-migration exact type gate separate', async () => {
  const [contentSync, migrationGate, packageJson, runbook] = await Promise.all([
    readFile('scripts/content-sync-linked.mjs', 'utf8'),
    readFile('scripts/check-linked-release-migrations.mjs', 'utf8'),
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('docs/release-i18n-zh-telegram.md', 'utf8'),
  ]);
  assert.match(contentSync, /LEGACY_RU_CONTENT_PULL_REQUIRES_CHECK_ONLY/u);
  assert.match(contentSync, /begin isolation level repeatable read read only/u);
  assert.match(contentSync, /mode: 'legacy-preflight'/u);
  assert.match(contentSync, /classifyLocalizedSchema/u);
  assert.match(contentSync, /legacyUnexpectedCanonicalFiles/u);
  assert.doesNotMatch(migrationGate, /db push|migration repair|writeFile|unlink|rename|rm\(/u);
  assert.equal(
    packageJson.scripts['db:migrations:check-preflight'],
    'node scripts/check-linked-release-migrations.mjs',
  );
  assert.equal(
    packageJson.scripts['db:types:check'],
    'node scripts/generate-supabase-types.mjs --linked --check',
  );
  assert.match(runbook, /db:migrations:check-preflight/u);
  assert.match(runbook, /db:types:check[\s\S]*after.*migrations|после применения migrations/iu);
});
