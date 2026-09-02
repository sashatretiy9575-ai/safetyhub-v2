import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertNoAnswerKeys,
  canonicalHash,
  loadStage6PublicationBatch,
  sha256,
  STAGE6_ALL_LOCALES,
} from './stage6-publication-contract.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class LocalizedSnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalizedSnapshotError';
    this.code = code;
  }
}

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SOURCE_CONTROLLED_CURRENT_LEGAL = new Map(
  [
    ['privacy', '1.4'],
    ['terms', '2.4'],
  ].map(([documentType, version]) => {
    const byLocale = new Map(
      STAGE6_ALL_LOCALES.map((locale) => {
        const filePath = path.join(
          REPOSITORY_ROOT,
          'content',
          'legal',
          documentType,
          `${version}.${locale}.json`,
        );
        const document = JSON.parse(readFileSync(filePath, 'utf8'));
        return [locale, document];
      }),
    );
    return [documentType, { version, byLocale }];
  }),
);

function fail(code) {
  throw new LocalizedSnapshotError(code);
}

function jsonEqual(left, right) {
  return canonicalHash(left) === canonicalHash(right);
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('LOCALIZED_SNAPSHOT_TIMESTAMP_INVALID');
  return date.toISOString();
}

function expectedVariantProjection(variant) {
  return {
    questions: variant.questions.map(({ id, text, options }, questionIndex) => ({
      id,
      text,
      displayOrder: questionIndex + 1,
      options: options.map(({ id: optionId, text: optionText }, optionIndex) => ({
        id: optionId,
        text: optionText,
        displayOrder: optionIndex + 1,
      })),
    })),
    explanations: variant.questions.map((question) => question.explanation ?? ''),
  };
}

function exactLocaleSet(rows, context) {
  const locales = rows.map((row) => row.locale).sort();
  if (JSON.stringify(locales) !== JSON.stringify([...STAGE6_ALL_LOCALES].sort())) {
    fail(`LOCALIZED_SNAPSHOT_LOCALES_INVALID_${context}`);
  }
}

function validatePresentationRow(row) {
  const expectedPrefix = `${row.course_id}/${row.locale}/${row.presentation_id}`;
  const legacyPrefix = `${row.course_id}/${row.presentation_id}`;
  const immutablePathValid =
    (row.storage_path === `${expectedPrefix}/${row.presentation_sha256}.pdf` &&
      row.thumbnail_path === `${expectedPrefix}/${row.presentation_sha256}-thumb.webp`) ||
    (row.locale === 'ru' &&
      row.storage_path === `${legacyPrefix}/${row.presentation_sha256}.pdf` &&
      row.thumbnail_path === `${legacyPrefix}/${row.presentation_sha256}-thumb.webp`);
  if (
    !UUID_PATTERN.test(row.presentation_id ?? '') ||
    row.presentation_locale !== row.locale ||
    row.presentation_status !== 'ready' ||
    row.storage_bucket !== 'course-presentations' ||
    row.mime_type !== 'application/pdf' ||
    row.aspect_ratio !== '16:9' ||
    !SHA256_PATTERN.test(row.presentation_sha256 ?? '') ||
    !Number.isSafeInteger(Number(row.presentation_byte_size)) ||
    Number(row.presentation_byte_size) < 1 ||
    Number(row.presentation_byte_size) > 25 * 1024 * 1024 ||
    !Number.isSafeInteger(Number(row.presentation_page_count)) ||
    Number(row.presentation_page_count) < 1 ||
    Number(row.presentation_page_count) > 200 ||
    !immutablePathValid
  ) {
    fail('LOCALIZED_SNAPSHOT_PRESENTATION_METADATA_INVALID');
  }
}

function stagedCourseEntry(batch, slug, locale) {
  const matches = batch.courses.filter((item) => item.slug === slug && item.locale === locale);
  if (matches.length !== 1) fail('LOCALIZED_SNAPSHOT_STAGE6_COURSE_MISSING');
  return matches[0];
}

function stagedArticleEntry(batch, slug, locale) {
  const matches = batch.articles.filter((item) => item.slug === slug && item.locale === locale);
  if (matches.length !== 1) fail('LOCALIZED_SNAPSHOT_STAGE6_ARTICLE_MISSING');
  return matches[0];
}

function compareStage6Legal(batch, row) {
  const descriptor = batch.legal.find((item) => item.documentType === row.document_type);
  if (!descriptor) return;
  if (row.version === descriptor.version) {
    const expected = descriptor.localizations.find((item) => item.locale === row.locale);
    if (
      !expected ||
      row.title !== expected.args.p_title ||
      !jsonEqual(row.body, expected.args.p_body) ||
      row.status !== 'published'
    ) {
      fail('LOCALIZED_SNAPSHOT_STAGE6_LEGAL_DRIFT');
    }
  } else if (row.version === descriptor.historicalVersion && row.locale !== 'ru') {
    const expected = descriptor.historical.find((item) => item.locale === row.locale);
    if (
      !expected ||
      row.title !== expected.title ||
      !jsonEqual(row.body, expected.body) ||
      row.status !== 'published'
    ) {
      fail('LOCALIZED_SNAPSHOT_HISTORICAL_LEGAL_DRIFT');
    }
  }
}

function compareSourceControlledCurrentLegal(row) {
  const source = SOURCE_CONTROLLED_CURRENT_LEGAL.get(row.document_type);
  if (!source || row.version !== source.version) return;
  const expected = source.byLocale.get(row.locale);
  if (
    !expected ||
    row.title !== expected.title ||
    !jsonEqual(row.body, expected.body) ||
    row.status !== 'published'
  ) {
    fail('LOCALIZED_SNAPSHOT_SOURCE_LEGAL_DRIFT');
  }
}

export function buildLocalizedPublishedSnapshot({
  batch,
  courseLocalizationRows,
  variantLocalizationRows,
  articleLocalizationRows,
  legalVersionRows,
  legalLocalizationRows,
  presentationAssets,
}) {
  if (!batch || batch.review?.productionPublished !== false) {
    fail('LOCALIZED_SNAPSHOT_STAGE6_BATCH_INVALID');
  }
  assertNoAnswerKeys({ courseLocalizationRows, variantLocalizationRows, articleLocalizationRows });
  const courseGroups = new Map();
  for (const row of courseLocalizationRows) {
    if (!UUID_PATTERN.test(row.course_id ?? '') || !UUID_PATTERN.test(row.revision_id ?? '')) {
      fail('LOCALIZED_SNAPSHOT_COURSE_ID_INVALID');
    }
    const collection = courseGroups.get(row.slug) ?? [];
    collection.push(row);
    courseGroups.set(row.slug, collection);
  }
  if (courseGroups.size !== 5 || courseLocalizationRows.length !== 20) {
    fail('LOCALIZED_SNAPSHOT_COURSE_COUNT_INVALID');
  }

  const files = new Map();
  const courses = [];
  let targetPageCount = 0;
  for (const [slug, rows] of [...courseGroups.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    exactLocaleSet(rows, 'COURSE');
    const revisionIds = new Set(rows.map((row) => row.revision_id));
    const courseIds = new Set(rows.map((row) => row.course_id));
    if (revisionIds.size !== 1 || courseIds.size !== 1) {
      fail('LOCALIZED_SNAPSHOT_COURSE_REVISION_SPLIT');
    }
    const variantRows = variantLocalizationRows.filter((row) => row.slug === slug);
    if (
      variantRows.length !== 12 ||
      variantRows.some((row) => row.revision_id !== rows[0].revision_id)
    ) {
      fail('LOCALIZED_SNAPSHOT_VARIANT_COUNT_INVALID');
    }
    const variants = [];
    for (const variantNumber of [1, 2, 3]) {
      const localized = variantRows.filter((row) => Number(row.variant_number) === variantNumber);
      exactLocaleSet(localized, 'VARIANT');
      const stableIds = new Set(localized.map((row) => row.stable_id));
      if (stableIds.size !== 1 || !UUID_PATTERN.test(localized[0]?.stable_id ?? '')) {
        fail('LOCALIZED_SNAPSHOT_VARIANT_ID_INVALID');
      }
      const structures = new Set(localized.map((row) => row.structure_hash));
      const stableTopology = new Set(
        localized.map((row) =>
          canonicalHash(
            row.questions.map((question) => ({
              id: question?.id,
              options: Array.isArray(question?.options)
                ? question.options.map((option) => option?.id)
                : null,
            })),
          ),
        ),
      );
      if (structures.size !== 1 || stableTopology.size !== 1) {
        fail('LOCALIZED_SNAPSHOT_VARIANT_STRUCTURE_DRIFT');
      }
      for (const row of localized) {
        if (
          !Array.isArray(row.questions) ||
          row.questions.length !== 10 ||
          !Array.isArray(row.explanations) ||
          row.explanations.length !== 10 ||
          row.questions.some(
            (question) => !Array.isArray(question?.options) || question.options.length !== 4,
          ) ||
          !SHA256_PATTERN.test(row.structure_hash ?? '') ||
          !SHA256_PATTERN.test(row.variant_content_hash ?? '')
        ) {
          fail('LOCALIZED_SNAPSHOT_VARIANT_SHAPE_INVALID');
        }
        if (row.locale !== 'ru') {
          const staged = stagedCourseEntry(batch, slug, row.locale);
          const expectedVariant = staged.assessment.questionVariants.find(
            (item) => item.id === row.stable_id && item.variantNumber === variantNumber,
          );
          const expected = expectedVariant ? expectedVariantProjection(expectedVariant) : null;
          if (
            !expected ||
            !jsonEqual(row.questions, expected.questions) ||
            !jsonEqual(row.explanations, expected.explanations)
          ) {
            fail('LOCALIZED_SNAPSHOT_ASSESSMENT_DRIFT');
          }
        }
      }
      variants.push({
        stableId: localized[0].stable_id,
        variantNumber,
        localizations: localized
          .sort((left, right) => left.locale.localeCompare(right.locale, 'en'))
          .map((row) => ({
            locale: row.locale,
            questions: row.questions,
            explanations: row.explanations,
            questionCount: Number(row.question_count),
            structureHash: row.structure_hash,
            contentHash: row.variant_content_hash,
          })),
      });
    }

    const localizations = [];
    for (const row of rows.sort((left, right) => left.locale.localeCompare(right.locale, 'en'))) {
      validatePresentationRow(row);
      if (!SHA256_PATTERN.test(row.localization_content_hash ?? '')) {
        fail('LOCALIZED_SNAPSHOT_COURSE_HASH_INVALID');
      }
      let asset = null;
      if (row.locale !== 'ru') {
        const staged = stagedCourseEntry(batch, slug, row.locale);
        if (
          row.title !== staged.draft.title ||
          row.description !== staged.draft.description ||
          !jsonEqual(row.content, staged.draft.content) ||
          !jsonEqual(row.seo, staged.draft.seo) ||
          !jsonEqual(row.sources, staged.draft.sources) ||
          row.presentation_sha256 !== staged.presentation.sha256 ||
          Number(row.presentation_byte_size) !== staged.presentation.byteSize ||
          Number(row.presentation_page_count) !== staged.presentation.pageCount
        ) {
          fail('LOCALIZED_SNAPSHOT_COURSE_DRIFT');
        }
        const hosted = presentationAssets.get(row.presentation_id);
        if (
          !hosted ||
          sha256(hosted.pdf) !== row.presentation_sha256 ||
          hosted.pdf.length !== Number(row.presentation_byte_size) ||
          !Buffer.isBuffer(hosted.thumbnail) ||
          hosted.thumbnail.length < 1
        ) {
          fail('LOCALIZED_SNAPSHOT_PRESENTATION_OBJECT_INVALID');
        }
        const pdfFile = `presentations/${slug}/${row.locale}/${row.presentation_sha256}.pdf`;
        const thumbnailHash = sha256(hosted.thumbnail);
        const thumbnailFile = `presentations/${slug}/${row.locale}/${row.presentation_sha256}-${thumbnailHash}.webp`;
        files.set(pdfFile, hosted.pdf);
        files.set(thumbnailFile, hosted.thumbnail);
        asset = {
          pdfFile,
          thumbnailFile,
          thumbnailSha256: thumbnailHash,
          thumbnailByteSize: hosted.thumbnail.length,
        };
        targetPageCount += Number(row.presentation_page_count);
      }
      localizations.push({
        locale: row.locale,
        title: row.title,
        description: row.description,
        content: row.content,
        seo: row.seo,
        sources: row.sources,
        contentHash: row.localization_content_hash,
        presentation: {
          id: row.presentation_id,
          locale: row.presentation_locale,
          storageBucket: row.storage_bucket,
          storagePath: row.storage_path,
          thumbnailPath: row.thumbnail_path,
          sourceFilename: row.source_filename,
          mimeType: row.mime_type,
          byteSize: Number(row.presentation_byte_size),
          sha256: row.presentation_sha256,
          pageCount: Number(row.presentation_page_count),
          aspectRatio: row.aspect_ratio,
          asset,
        },
      });
    }
    courses.push({
      courseId: rows[0].course_id,
      revisionId: rows[0].revision_id,
      slug,
      localizations,
      variants,
    });
  }
  if (targetPageCount !== 594 || presentationAssets.size !== 15) {
    fail('LOCALIZED_SNAPSHOT_PRESENTATION_ASSET_COUNT_INVALID');
  }

  const articleGroups = new Map();
  for (const row of articleLocalizationRows) {
    if (!UUID_PATTERN.test(row.article_id ?? '') || !UUID_PATTERN.test(row.revision_id ?? '')) {
      fail('LOCALIZED_SNAPSHOT_ARTICLE_ID_INVALID');
    }
    const collection = articleGroups.get(row.slug) ?? [];
    collection.push(row);
    articleGroups.set(row.slug, collection);
  }
  if (articleGroups.size !== 10 || articleLocalizationRows.length !== 40) {
    fail('LOCALIZED_SNAPSHOT_ARTICLE_COUNT_INVALID');
  }
  const articles = [];
  for (const [slug, rows] of [...articleGroups.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    exactLocaleSet(rows, 'ARTICLE');
    const ids = new Set(rows.map((row) => row.article_id));
    const revisions = new Set(rows.map((row) => row.revision_id));
    if (ids.size !== 1 || revisions.size !== 1) {
      fail('LOCALIZED_SNAPSHOT_ARTICLE_REVISION_SPLIT');
    }
    for (const row of rows) {
      if (!SHA256_PATTERN.test(row.localization_content_hash ?? '')) {
        fail('LOCALIZED_SNAPSHOT_ARTICLE_HASH_INVALID');
      }
      if (row.locale !== 'ru') {
        const staged = stagedArticleEntry(batch, slug, row.locale).document;
        if (
          row.title !== staged.title ||
          row.description !== staged.description ||
          !jsonEqual(row.blocks, staged.blocks) ||
          !jsonEqual(row.seo, staged.seo) ||
          !jsonEqual(row.sources, staged.sources)
        ) {
          fail('LOCALIZED_SNAPSHOT_ARTICLE_DRIFT');
        }
      }
    }
    articles.push({
      articleId: rows[0].article_id,
      revisionId: rows[0].revision_id,
      slug,
      localizations: rows
        .sort((left, right) => left.locale.localeCompare(right.locale, 'en'))
        .map((row) => ({
          locale: row.locale,
          title: row.title,
          description: row.description,
          blocks: row.blocks,
          seo: row.seo,
          sources: row.sources,
          contentHash: row.localization_content_hash,
        })),
    });
  }

  const legalVersionKeys = new Set(
    legalVersionRows.map((version) => `${version.document_type}:${version.version}`),
  );
  const legalLocalizationKeys = new Set(
    legalLocalizationRows.map((row) => `${row.document_type}:${row.version}:${row.locale}`),
  );
  if (
    legalVersionKeys.size !== legalVersionRows.length ||
    legalLocalizationKeys.size !== legalLocalizationRows.length ||
    legalLocalizationRows.some(
      (row) => !legalVersionKeys.has(`${row.document_type}:${row.version}`),
    )
  ) {
    fail('LOCALIZED_SNAPSHOT_LEGAL_IDENTITY_INVALID');
  }
  const legalVersions = legalVersionRows
    .map((version) => {
      const localizations = legalLocalizationRows
        .filter(
          (row) => row.document_type === version.document_type && row.version === version.version,
        )
        .sort((left, right) => left.locale.localeCompare(right.locale, 'en'));
      for (const row of localizations) {
        if (
          !STAGE6_ALL_LOCALES.includes(row.locale) ||
          !SHA256_PATTERN.test(row.body_hash ?? '') ||
          !['draft', 'complete', 'published'].includes(row.status)
        ) {
          fail('LOCALIZED_SNAPSHOT_LEGAL_ROW_INVALID');
        }
        // The Stage 6 receipt remains an immutable historical source after a
        // later legal revision becomes current. It must still match exactly,
        // but it no longer owns the database's current-version pointer.
        compareStage6Legal(batch, row);
        compareSourceControlledCurrentLegal(row);
      }
      return {
        documentType: version.document_type,
        version: version.version,
        bodyRevision: version.body_revision,
        effectiveAt: isoTimestamp(version.effective_at),
        isCurrent: Boolean(version.is_current),
        localizations: localizations.map((row) => ({
          locale: row.locale,
          title: row.title,
          body: row.body,
          bodyHash: row.body_hash,
          status: row.status,
        })),
      };
    })
    .sort((left, right) =>
      `${left.documentType}:${left.version}`.localeCompare(
        `${right.documentType}:${right.version}`,
        'en',
      ),
    );
  if (
    legalVersions.length < 4 ||
    legalLocalizationRows.length < 16 ||
    legalVersions.filter((version) => version.isCurrent).length !== 2 ||
    batch.legal.some((expected) => {
      const stage6 = legalVersions.find(
        (item) => item.documentType === expected.documentType && item.version === expected.version,
      );
      const historical = legalVersions.find(
        (item) =>
          item.documentType === expected.documentType &&
          item.version === expected.historicalVersion,
      );
      return (
        stage6?.localizations.length !== 4 ||
        stage6.localizations.some((localization) => localization.status !== 'published') ||
        historical?.isCurrent ||
        historical?.localizations.length !== 4 ||
        historical.localizations.some((localization) => localization.status !== 'published')
      );
    }) ||
    ['privacy', 'terms'].some((documentType) => {
      const current = legalVersions.find(
        (item) => item.documentType === documentType && item.isCurrent,
      );
      const source = SOURCE_CONTROLLED_CURRENT_LEGAL.get(documentType);
      const sourceVersion = legalVersions.find(
        (item) => item.documentType === documentType && item.version === source.version,
      );
      const sourceIsFullyPublished =
        sourceVersion?.localizations.length === 4 &&
        sourceVersion.localizations.every(
          (localization) => localization.status === 'published',
        );
      const expectedVersion = sourceIsFullyPublished
        ? source.version
        : batch.legal.find((item) => item.documentType === documentType)?.version;
      return (
        !current ||
        current.version !== expectedVersion ||
        current.localizations.length !== 4 ||
        current.localizations.some((localization) => localization.status !== 'published')
      );
    })
  ) {
    fail('LOCALIZED_SNAPSHOT_LEGAL_COMPLETENESS_INVALID');
  }

  const counts = {
    courseCount: courses.length,
    courseLocalizationCount: courseLocalizationRows.length,
    variantCount: courses.reduce((total, course) => total + course.variants.length, 0),
    variantLocalizationCount: variantLocalizationRows.length,
    questionCount: variantLocalizationRows.reduce(
      (total, row) => total + Number(row.question_count),
      0,
    ),
    optionCount: variantLocalizationRows.reduce(
      (total, row) =>
        total + row.questions.reduce((sum, question) => sum + question.options.length, 0),
      0,
    ),
    presentationRowCount: courseLocalizationRows.length,
    localizedPresentationAssetCount: presentationAssets.size,
    localizedPresentationPageCount: targetPageCount,
    articleCount: articles.length,
    articleLocalizationCount: articleLocalizationRows.length,
    legalVersionCount: legalVersions.length,
    legalLocalizationCount: legalLocalizationRows.length,
  };
  const projection = {
    schemaVersion: 1,
    batchId: batch.batchId,
    reviewedBatchSha256: batch.batchHash,
    artifactManifestSha256: batch.artifactManifestHash,
    locales: [...STAGE6_ALL_LOCALES],
    productionPublished: true,
    answerKeysIncluded: false,
    operationalPiiIncluded: false,
    counts,
    courses,
    articles,
    legalVersions,
  };
  const manifest = { ...projection, manifestHash: canonicalHash(projection) };
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return { manifest, files };
}

function safeSnapshotFile(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length < 1 ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath)
  ) {
    fail('LOCALIZED_SNAPSHOT_FILE_PATH_INVALID');
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('LOCALIZED_SNAPSHOT_FILE_PATH_INVALID');
  }
  return absolute;
}

export async function validateLocalizedPublishedSnapshot({
  root = process.cwd(),
  snapshotRoot = path.join(root, 'content', 'snapshots', 'localizations'),
  required = true,
  compareReviewedBatch = true,
} = {}) {
  let manifestBytes;
  try {
    manifestBytes = await readFile(path.join(snapshotRoot, 'manifest.json'));
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return { present: false };
    fail('LOCALIZED_SNAPSHOT_MANIFEST_MISSING');
  }
  if (manifestBytes.length < 2 || manifestBytes.length > 8 * 1024 * 1024) {
    fail('LOCALIZED_SNAPSHOT_MANIFEST_SIZE_INVALID');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('LOCALIZED_SNAPSHOT_MANIFEST_JSON_INVALID');
  }
  const { manifestHash, ...projection } = manifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.productionPublished !== true ||
    manifest.answerKeysIncluded !== false ||
    manifest.operationalPiiIncluded !== false ||
    !SHA256_PATTERN.test(manifest.reviewedBatchSha256 ?? '') ||
    !SHA256_PATTERN.test(manifest.artifactManifestSha256 ?? '') ||
    manifestHash !== canonicalHash(projection) ||
    manifest.counts?.courseCount !== 5 ||
    manifest.counts?.courseLocalizationCount !== 20 ||
    manifest.counts?.variantCount !== 15 ||
    manifest.counts?.variantLocalizationCount !== 60 ||
    manifest.counts?.questionCount !== 600 ||
    manifest.counts?.optionCount !== 2400 ||
    manifest.counts?.presentationRowCount !== 20 ||
    manifest.counts?.localizedPresentationAssetCount !== 15 ||
    manifest.counts?.localizedPresentationPageCount !== 594 ||
    manifest.counts?.articleCount !== 10 ||
    manifest.counts?.articleLocalizationCount !== 40 ||
    !Array.isArray(manifest.courses) ||
    !Array.isArray(manifest.articles) ||
    !Array.isArray(manifest.legalVersions)
  ) {
    fail('LOCALIZED_SNAPSHOT_MANIFEST_INVALID');
  }
  assertNoAnswerKeys(manifest);
  const batch = await loadStage6PublicationBatch({ root, validateRelease: false });
  if (compareReviewedBatch) {
    if (
      manifest.batchId !== batch.batchId ||
      manifest.reviewedBatchSha256 !== batch.batchHash ||
      manifest.artifactManifestSha256 !== batch.artifactManifestHash
    ) {
      fail('LOCALIZED_SNAPSHOT_REVIEW_BINDING_INVALID');
    }
  }
  const expectedFiles = new Set(['manifest.json']);
  const presentationAssets = new Map();
  let assetCount = 0;
  for (const course of manifest.courses) {
    exactLocaleSet(course.localizations, 'MANIFEST_COURSE');
    for (const localization of course.localizations) {
      const presentation = localization.presentation;
      if (localization.locale === 'ru') {
        if (presentation.asset !== null) fail('LOCALIZED_SNAPSHOT_RU_ASSET_DUPLICATED');
        continue;
      }
      const asset = presentation.asset;
      if (
        !asset ||
        !SHA256_PATTERN.test(presentation.sha256 ?? '') ||
        !SHA256_PATTERN.test(asset.thumbnailSha256 ?? '')
      ) {
        fail('LOCALIZED_SNAPSHOT_ASSET_RECEIPT_INVALID');
      }
      const [pdf, thumbnail] = await Promise.all([
        readFile(safeSnapshotFile(snapshotRoot, asset.pdfFile)),
        readFile(safeSnapshotFile(snapshotRoot, asset.thumbnailFile)),
      ]);
      if (
        pdf.length !== presentation.byteSize ||
        sha256(pdf) !== presentation.sha256 ||
        thumbnail.length !== asset.thumbnailByteSize ||
        sha256(thumbnail) !== asset.thumbnailSha256 ||
        pdf.subarray(0, 5).toString('ascii') !== '%PDF-' ||
        thumbnail.subarray(0, 4).toString('ascii') !== 'RIFF' ||
        thumbnail.subarray(8, 12).toString('ascii') !== 'WEBP'
      ) {
        fail('LOCALIZED_SNAPSHOT_ASSET_HASH_INVALID');
      }
      expectedFiles.add(asset.pdfFile);
      expectedFiles.add(asset.thumbnailFile);
      presentationAssets.set(presentation.id, { pdf, thumbnail });
      assetCount += 1;
    }
  }

  const courseLocalizationRows = manifest.courses.flatMap((course) =>
    course.localizations.map((localization) => ({
      course_id: course.courseId,
      revision_id: course.revisionId,
      slug: course.slug,
      locale: localization.locale,
      title: localization.title,
      description: localization.description,
      content: localization.content,
      seo: localization.seo,
      sources: localization.sources,
      localization_content_hash: localization.contentHash,
      presentation_id: localization.presentation.id,
      presentation_locale: localization.presentation.locale,
      storage_bucket: localization.presentation.storageBucket,
      storage_path: localization.presentation.storagePath,
      thumbnail_path: localization.presentation.thumbnailPath,
      source_filename: localization.presentation.sourceFilename,
      mime_type: localization.presentation.mimeType,
      presentation_byte_size: localization.presentation.byteSize,
      presentation_sha256: localization.presentation.sha256,
      presentation_page_count: localization.presentation.pageCount,
      aspect_ratio: localization.presentation.aspectRatio,
      presentation_status: 'ready',
    })),
  );
  const variantLocalizationRows = manifest.courses.flatMap((course) =>
    course.variants.flatMap((variant) =>
      variant.localizations.map((localization) => ({
        revision_id: course.revisionId,
        slug: course.slug,
        stable_id: variant.stableId,
        variant_number: variant.variantNumber,
        locale: localization.locale,
        questions: localization.questions,
        explanations: localization.explanations,
        question_count: localization.questionCount,
        structure_hash: localization.structureHash,
        variant_content_hash: localization.contentHash,
      })),
    ),
  );
  const articleLocalizationRows = manifest.articles.flatMap((article) =>
    article.localizations.map((localization) => ({
      article_id: article.articleId,
      revision_id: article.revisionId,
      slug: article.slug,
      locale: localization.locale,
      title: localization.title,
      description: localization.description,
      blocks: localization.blocks,
      seo: localization.seo,
      sources: localization.sources,
      localization_content_hash: localization.contentHash,
    })),
  );
  const legalVersionRows = manifest.legalVersions.map((version) => ({
    document_type: version.documentType,
    version: version.version,
    body_revision: version.bodyRevision,
    effective_at: version.effectiveAt,
    is_current: version.isCurrent,
  }));
  const legalLocalizationRows = manifest.legalVersions.flatMap((version) =>
    version.localizations.map((localization) => ({
      document_type: version.documentType,
      version: version.version,
      locale: localization.locale,
      title: localization.title,
      body: localization.body,
      body_hash: localization.bodyHash,
      status: localization.status,
    })),
  );
  const rebuilt = buildLocalizedPublishedSnapshot({
    batch,
    courseLocalizationRows,
    variantLocalizationRows,
    articleLocalizationRows,
    legalVersionRows,
    legalLocalizationRows,
    presentationAssets,
  });
  if (
    rebuilt.manifest.manifestHash !== manifestHash ||
    canonicalHash(rebuilt.manifest) !== canonicalHash(manifest)
  ) {
    fail('LOCALIZED_SNAPSHOT_CANONICAL_REBUILD_MISMATCH');
  }

  const actualFiles = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        actualFiles.push(path.relative(snapshotRoot, absolute).replaceAll('\\', '/'));
      } else {
        fail('LOCALIZED_SNAPSHOT_SPECIAL_FILE_FORBIDDEN');
      }
    }
  };
  await visit(snapshotRoot);
  if (
    assetCount !== 15 ||
    JSON.stringify(actualFiles.sort()) !== JSON.stringify([...expectedFiles].sort())
  ) {
    fail('LOCALIZED_SNAPSHOT_FILE_SET_INVALID');
  }
  return {
    present: true,
    manifestHash,
    reviewedBatchSha256: manifest.reviewedBatchSha256,
    counts: manifest.counts,
  };
}
