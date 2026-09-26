export const LEGACY_RU_CATALOG_CHECKSUM =
  '9d34b6b4f106b6886a540e0b67c2f7be27ffa6b1e3e4656013e6192ed39c228a';

export const LEGACY_RU_CONTENT_TOTALS = Object.freeze({
  courseCount: 5,
  presentationCount: 5,
  presentationPageCount: 198,
  variantCount: 15,
  questionCount: 150,
  optionCount: 600,
  correctAnswerCount: 150,
  articleCount: 10,
});

export const LOCALIZED_SCHEMA_SENTINELS = Object.freeze([
  'appLocale',
  'legalDocumentLocalizations',
  'testRevisionLocalizations',
  'testRevisionPresentations',
  'testRevisionVariantLocalizations',
  'articleRevisionLocalizations',
]);

function fail(code) {
  throw new Error(code);
}

export function classifyLocalizedSchema(row) {
  if (!row || typeof row !== 'object') fail('CONTENT_SCHEMA_STATE_INVALID');
  const values = LOCALIZED_SCHEMA_SENTINELS.map((name) => row[name]);
  if (!values.every((value) => typeof value === 'boolean')) {
    fail('CONTENT_SCHEMA_STATE_INVALID');
  }
  if (values.every(Boolean)) return 'localized';
  if (values.every((value) => value === false)) return 'legacy-ru';
  fail('CONTENT_SCHEMA_PARTIALLY_APPLIED');
}

function exactInteger(value, expected, code) {
  if (!Number.isSafeInteger(value) || value !== expected) fail(code);
}

export function assertLegacyRuContentContract({
  catalogChecksum,
  localCatalogChecksum,
  totals,
  articleCount,
  courses,
}) {
  if (
    catalogChecksum !== LEGACY_RU_CATALOG_CHECKSUM ||
    localCatalogChecksum !== LEGACY_RU_CATALOG_CHECKSUM
  ) {
    fail('LEGACY_RU_CATALOG_CHECKSUM_MISMATCH');
  }
  if (!totals || typeof totals !== 'object') fail('LEGACY_RU_TOTALS_INVALID');
  for (const [name, expected] of Object.entries(LEGACY_RU_CONTENT_TOTALS)) {
    const value = name === 'articleCount' ? articleCount : totals[name];
    exactInteger(
      value,
      expected,
      `LEGACY_RU_${name.replaceAll(/(?=[A-Z])/gu, '_').toUpperCase()}_MISMATCH`,
    );
  }
  if (!Array.isArray(courses) || courses.length !== LEGACY_RU_CONTENT_TOTALS.courseCount) {
    fail('LEGACY_RU_COURSE_SHAPE_MISMATCH');
  }
  for (const course of courses) {
    if (
      !course ||
      course.durationMinutes !== 15 ||
      course.passScore !== 7 ||
      course.attemptsPerCalendarDay !== 8 ||
      course.resetTimezone !== 'Asia/Oral' ||
      !Array.isArray(course.variants) ||
      course.variants.length !== 3
    ) {
      fail('LEGACY_RU_COURSE_SHAPE_MISMATCH');
    }
    for (const variant of course.variants) {
      if (!Array.isArray(variant) || variant.length !== 10) {
        fail('LEGACY_RU_VARIANT_SHAPE_MISMATCH');
      }
      if (!variant.every((optionCount) => optionCount === 4)) {
        fail('LEGACY_RU_OPTION_SHAPE_MISMATCH');
      }
    }
  }
  return Object.freeze({
    catalogChecksum: LEGACY_RU_CATALOG_CHECKSUM,
    totals: LEGACY_RU_CONTENT_TOTALS,
    coursePolicy: Object.freeze({
      variantCount: 3,
      questionCount: 10,
      optionCount: 4,
      durationMinutes: 15,
      passScore: 7,
      attemptsPerCalendarDay: 8,
      resetTimezone: 'Asia/Oral',
    }),
  });
}
