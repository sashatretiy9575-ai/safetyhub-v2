import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const STAGE6_BATCH_ID = 'staged-2026-09-01';
export const STAGE6_TARGET_LOCALES = Object.freeze(['kk', 'en', 'zh']);
export const STAGE6_ALL_LOCALES = Object.freeze(['ru', ...STAGE6_TARGET_LOCALES]);
export const STAGE6_EXPECTED = Object.freeze({
  courseCount: 5,
  courseLocalizationCount: 15,
  presentationCount: 15,
  presentationPageCount: 594,
  variantCount: 45,
  questionCount: 450,
  optionCount: 1800,
  articleCount: 10,
  articleLocalizationCount: 30,
  currentLegalDocumentCount: 2,
  currentLegalLocalizationCount: 8,
  historicalLegalLocalizationCount: 6,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FORBIDDEN_ASSESSMENT_KEYS = new Set([
  'correct',
  'correctAnswer',
  'correctOptionId',
  'correctOptionIds',
  'correctOptionIndex',
  'correct_option_id',
  'correct_option_ids',
  'answerKey',
  'answerKeys',
]);

export class Stage6PublicationContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Stage6PublicationContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new Stage6PublicationContractError(code);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function canonicalHash(value) {
  return sha256(Buffer.from(JSON.stringify(sortJson(value)), 'utf8'));
}

function safePath(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length < 1 ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath)
  ) {
    fail('STAGE6_ARTIFACT_PATH_INVALID');
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('STAGE6_ARTIFACT_PATH_INVALID');
  }
  return absolute;
}

async function readJson(filePath, maximumBytes = 4 * 1024 * 1024) {
  const bytes = await readFile(filePath);
  if (bytes.length < 2 || bytes.length > maximumBytes) fail('STAGE6_JSON_SIZE_INVALID');
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    fail('STAGE6_JSON_INVALID');
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function countAssessment(questionVariants) {
  const variants = Array.isArray(questionVariants) ? questionVariants : [];
  const questions = variants.flatMap((variant) =>
    Array.isArray(variant?.questions) ? variant.questions : [],
  );
  const options = questions.flatMap((question) =>
    Array.isArray(question?.options) ? question.options : [],
  );
  return { variants: variants.length, questions: questions.length, options: options.length };
}

function onlyAllowedKeys(value, allowed) {
  return (
    record(value) && Object.keys(value).every((key) => allowed.includes(key))
  );
}

export function assertNoAnswerKeys(value) {
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_ASSESSMENT_KEYS.has(key)) fail('STAGE6_ANSWER_KEY_FIELD_FORBIDDEN');
      visit(child);
    }
  };
  visit(value);
}

export function validateStage6Release(root = process.cwd()) {
  const script = path.join(
    root,
    'scripts',
    'content-localization',
    'validate-stage6-localizations.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [script, '--require-binaries', '--require-independent-review'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) fail('STAGE6_RELEASE_VALIDATION_FAILED');
  let receipt;
  try {
    receipt = JSON.parse(`${result.stdout}`.trim().split(/\r?\n/u).at(-1));
  } catch {
    fail('STAGE6_RELEASE_VALIDATION_RECEIPT_INVALID');
  }
  if (
    receipt?.ok !== true ||
    receipt?.courses !== STAGE6_EXPECTED.courseCount ||
    receipt?.presentationBinaryReceipts !== STAGE6_EXPECTED.presentationCount ||
    receipt?.articles !== STAGE6_EXPECTED.articleCount ||
    receipt?.localizedSlides !== STAGE6_EXPECTED.presentationPageCount
  ) {
    fail('STAGE6_RELEASE_VALIDATION_RECEIPT_INVALID');
  }
  return receipt;
}

function presentationReceiptEntry(value, slug, locale) {
  const entries = Array.isArray(value?.presentations) ? value.presentations : [];
  const matches = entries.filter((entry) => entry?.slug === slug && entry?.locale === locale);
  if (matches.length !== 1) fail('STAGE6_PRESENTATION_RECEIPT_MISSING');
  return matches[0];
}

function validateQuestionTopology(bundle, courseId, locale) {
  if (
    bundle?.version !== 1 ||
    bundle?.courseId !== courseId ||
    bundle?.locale !== locale ||
    !Array.isArray(bundle?.questionVariants) ||
    bundle.questionVariants.length !== 3
  ) {
    fail('STAGE6_ASSESSMENT_CONTRACT_INVALID');
  }
  assertNoAnswerKeys(bundle.questionVariants);
  const allIds = [];
  for (const [variantIndex, variant] of bundle.questionVariants.entries()) {
    if (
      !onlyAllowedKeys(variant, ['id', 'variantNumber', 'questions']) ||
      !UUID_PATTERN.test(variant?.id ?? '') ||
      variant.variantNumber !== variantIndex + 1 ||
      !Array.isArray(variant.questions) ||
      variant.questions.length !== 10
    ) {
      fail('STAGE6_ASSESSMENT_TOPOLOGY_INVALID');
    }
    allIds.push(variant.id);
    for (const [questionIndex, question] of variant.questions.entries()) {
      if (
        !onlyAllowedKeys(question, [
          'id',
          'text',
          'explanation',
          'position',
          'displayOrder',
          'options',
        ]) ||
        !UUID_PATTERN.test(question?.id ?? '') ||
        typeof question.text !== 'string' ||
        question.text.trim().length < 1 ||
        !Array.isArray(question.options) ||
        question.options.length !== 4 ||
        typeof question.explanation !== 'string' ||
        (question.position !== undefined && question.position !== questionIndex + 1) ||
        (question.displayOrder !== undefined && question.displayOrder !== questionIndex + 1)
      ) {
        fail('STAGE6_ASSESSMENT_TOPOLOGY_INVALID');
      }
      allIds.push(question.id);
      for (const [optionIndex, option] of question.options.entries()) {
        if (
          !onlyAllowedKeys(option, ['id', 'text', 'position', 'displayOrder']) ||
          !UUID_PATTERN.test(option?.id ?? '') ||
          typeof option.text !== 'string' ||
          option.text.trim().length < 1 ||
          (option.position !== undefined && option.position !== optionIndex + 1) ||
          (option.displayOrder !== undefined && option.displayOrder !== optionIndex + 1)
        ) {
          fail('STAGE6_ASSESSMENT_TOPOLOGY_INVALID');
        }
        allIds.push(option.id);
      }
    }
  }
  if (new Set(allIds).size !== allIds.length) fail('STAGE6_ASSESSMENT_IDS_DUPLICATE');
}

function normalizeHistoricalLegalBody(document) {
  if (!Array.isArray(document?.sections) || document.sections.length < 1) {
    fail('STAGE6_HISTORICAL_LEGAL_INVALID');
  }
  return { sections: document.sections };
}

export async function loadStage6PublicationBatch({
  root = process.cwd(),
  validateRelease = true,
} = {}) {
  if (validateRelease) validateStage6Release(root);
  const batchRoot = path.join(root, 'content', 'localizations', STAGE6_BATCH_ID);
  const reviewPath = path.join(batchRoot, 'qa', 'automated-review-receipt.json');
  const review = await readJson(reviewPath, 512 * 1024);
  const batchHash = sha256(review.bytes);
  if (
    review.value?.schemaVersion !== 1 ||
    review.value?.batchId !== STAGE6_BATCH_ID ||
    review.value?.productionPublished !== false ||
    review.value?.mode !== 'automated-only' ||
    review.value?.checks?.answerKeysIncluded !== false ||
    review.value?.checks?.invariantFailureCount !== 0 ||
    !Array.isArray(review.value?.artifacts)
  ) {
    fail('STAGE6_REVIEW_RECEIPT_INVALID');
  }
  const artifacts = new Map();
  for (const artifact of review.value.artifacts) {
    if (
      !record(artifact) ||
      typeof artifact.path !== 'string' ||
      !SHA256_PATTERN.test(artifact.sha256 ?? '') ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifacts.has(artifact.path)
    ) {
      fail('STAGE6_REVIEW_ARTIFACT_INDEX_INVALID');
    }
    artifacts.set(artifact.path, artifact);
  }

  const readReviewed = async (relativePath, maximumBytes) => {
    const receipt = artifacts.get(relativePath);
    if (!receipt) fail('STAGE6_REVIEW_ARTIFACT_UNLISTED');
    const absolute = safePath(batchRoot, relativePath);
    const bytes = await readFile(absolute);
    if (
      bytes.length !== receipt.bytes ||
      bytes.length > maximumBytes ||
      sha256(bytes) !== receipt.sha256
    ) {
      fail('STAGE6_REVIEW_ARTIFACT_HASH_MISMATCH');
    }
    return { absolute, bytes, receipt };
  };
  const readReviewedJson = async (relativePath, maximumBytes = 4 * 1024 * 1024) => {
    const reviewed = await readReviewed(relativePath, maximumBytes);
    try {
      return { ...reviewed, value: JSON.parse(reviewed.bytes.toString('utf8')) };
    } catch {
      fail('STAGE6_REVIEW_ARTIFACT_JSON_INVALID');
    }
  };

  const visual = await readReviewedJson(
    'qa/presentation-visual-qa-receipt.all.json',
    256 * 1024,
  );
  if (
    visual.value?.productionPublished !== false ||
    visual.value?.presentationCount !== STAGE6_EXPECTED.presentationCount ||
    visual.value?.pdfRenderedPageCount !== STAGE6_EXPECTED.presentationPageCount
  ) {
    fail('STAGE6_PRESENTATION_AGGREGATE_INVALID');
  }

  const catalog = JSON.parse(
    await readFile(path.join(root, 'content', 'snapshots', 'courses', 'catalog.json'), 'utf8'),
  );
  if (!Array.isArray(catalog?.courses) || catalog.courses.length !== 5) {
    fail('STAGE6_SOURCE_CATALOG_INVALID');
  }
  const courses = [];
  let variantCount = 0;
  let questionCount = 0;
  let optionCount = 0;
  let presentationPageCount = 0;
  for (const sourceCourse of catalog.courses) {
    if (!UUID_PATTERN.test(sourceCourse?.id ?? '') || typeof sourceCourse.slug !== 'string') {
      fail('STAGE6_SOURCE_CATALOG_INVALID');
    }
    for (const locale of STAGE6_TARGET_LOCALES) {
      const prefix = `courses/${sourceCourse.slug}/${locale}`;
      const [draft, assessment] = await Promise.all([
        readReviewedJson(`${prefix}/course-draft.json`),
        readReviewedJson(`${prefix}/assessment-import.json`),
      ]);
      if (
        draft.value?.version !== 1 ||
        draft.value?.courseId !== sourceCourse.id ||
        draft.value?.slug !== sourceCourse.slug ||
        draft.value?.locale !== locale ||
        typeof draft.value.title !== 'string' ||
        typeof draft.value.description !== 'string' ||
        !record(draft.value.content) ||
        !record(draft.value.seo) ||
        !Array.isArray(draft.value.sources) ||
        draft.value.answerKeysIncluded !== false
      ) {
        fail('STAGE6_COURSE_DRAFT_INVALID');
      }
      assertNoAnswerKeys(draft.value);
      validateQuestionTopology(assessment.value, sourceCourse.id, locale);
      const counts = countAssessment(assessment.value.questionVariants);
      variantCount += counts.variants;
      questionCount += counts.questions;
      optionCount += counts.options;

      const presentation = presentationReceiptEntry(
        visual.value,
        sourceCourse.slug,
        locale,
      );
      if (
        !record(presentation.pdf) ||
        !SHA256_PATTERN.test(presentation.pdf.sha256 ?? '') ||
        presentation.pdf.mimeType !== 'application/pdf' ||
        presentation.pdf.aspectRatio !== '16:9' ||
        !Number.isSafeInteger(presentation.pdf.byteSize) ||
        !Number.isSafeInteger(presentation.pdf.pageCount) ||
        presentation.pdf.pageCount < 1 ||
        presentation.pdf.pageCount > 200
      ) {
        fail('STAGE6_PRESENTATION_ENTRY_INVALID');
      }
      const batchPrefix = `content/localizations/${STAGE6_BATCH_ID}/`;
      if (!presentation.pdf.path.startsWith(batchPrefix)) {
        fail('STAGE6_PRESENTATION_PATH_INVALID');
      }
      const pdfRelative = presentation.pdf.path.slice(batchPrefix.length);
      const pdf = await readReviewed(pdfRelative, 25 * 1024 * 1024);
      if (
        pdf.bytes.length !== presentation.pdf.byteSize ||
        sha256(pdf.bytes) !== presentation.pdf.sha256 ||
        pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
      ) {
        fail('STAGE6_PRESENTATION_BINARY_INVALID');
      }
      presentationPageCount += presentation.pdf.pageCount;
      courses.push({
        courseId: sourceCourse.id,
        slug: sourceCourse.slug,
        locale,
        draft: draft.value,
        assessment: assessment.value,
        presentation: {
          pdf,
          sha256: presentation.pdf.sha256,
          byteSize: presentation.pdf.byteSize,
          pageCount: presentation.pdf.pageCount,
          sourceFilename: `${sourceCourse.slug}-${locale}-${presentation.pdf.sha256.slice(0, 12)}.pdf`,
        },
      });
    }
  }

  const articleRoot = path.join(batchRoot, 'articles');
  const articleSlugs = (await readdir(articleRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (articleSlugs.length !== STAGE6_EXPECTED.articleCount) {
    fail('STAGE6_ARTICLE_COUNT_INVALID');
  }
  const articles = [];
  for (const slug of articleSlugs) {
    for (const locale of STAGE6_TARGET_LOCALES) {
      const artifact = await readReviewedJson(`articles/${slug}/${locale}.json`);
      if (
        artifact.value?.schemaVersion !== 1 ||
        artifact.value?.sourceSlug !== slug ||
        artifact.value?.slug !== slug ||
        artifact.value?.locale !== locale ||
        typeof artifact.value.title !== 'string' ||
        typeof artifact.value.description !== 'string' ||
        !Array.isArray(artifact.value.blocks) ||
        !record(artifact.value.seo) ||
        !Array.isArray(artifact.value.sources)
      ) {
        fail('STAGE6_ARTICLE_INVALID');
      }
      articles.push({ slug, locale, document: artifact.value });
    }
  }

  const legal = [];
  for (const descriptor of [
    { documentType: 'privacy', historicalVersion: '1.2', version: '1.3' },
    { documentType: 'terms', historicalVersion: '2.2', version: '2.3' },
  ]) {
    const currentPrefix = `legal/${descriptor.documentType}/${descriptor.version}`;
    const [publication, stage, historicalPublishReceipt] = await Promise.all([
      readReviewedJson(`${currentPrefix}/publication-receipt.json`, 128 * 1024),
      readReviewedJson(`${currentPrefix}/stage-rpc.json`, 16 * 1024),
      readReviewedJson(`${currentPrefix}/publish-rpc.json`, 16 * 1024),
    ]);
    if (
      publication.value?.productionPublished !== false ||
      publication.value?.documentType !== descriptor.documentType ||
      publication.value?.version !== descriptor.version ||
      stage.value?.function !== 'stage_legal_document_version' ||
      // Stage 6 is a frozen historical receipt. Its original per-document
      // publication descriptor remains a provenance artifact protected by the
      // reviewed manifest; it is never returned as executable runtime input.
      historicalPublishReceipt.value?.function !== 'publish_legal_document_localizations' ||
      stage.value?.args?.p_document_type !== descriptor.documentType ||
      stage.value?.args?.p_version !== descriptor.version ||
      historicalPublishReceipt.value?.args?.p_document_type !== descriptor.documentType ||
      historicalPublishReceipt.value?.args?.p_version !== descriptor.version
    ) {
      fail('STAGE6_CURRENT_LEGAL_CONTRACT_INVALID');
    }
    const localizations = [];
    for (const locale of STAGE6_ALL_LOCALES) {
      const save = await readReviewedJson(`${currentPrefix}/${locale}/save-rpc.json`);
      const args = save.value?.args;
      if (
        save.value?.function !== 'save_legal_document_localization' ||
        args?.p_document_type !== descriptor.documentType ||
        args?.p_version !== descriptor.version ||
        args?.p_locale !== locale ||
        args?.p_complete !== true ||
        typeof args?.p_title !== 'string' ||
        !record(args?.p_body)
      ) {
        fail('STAGE6_CURRENT_LEGAL_LOCALIZATION_INVALID');
      }
      localizations.push({ locale, args });
    }
    const historical = [];
    for (const locale of STAGE6_TARGET_LOCALES) {
      const copy = await readReviewedJson(
        `legal/${descriptor.documentType}/${descriptor.historicalVersion}/${locale}.json`,
      );
      if (
        copy.value?.schemaVersion !== 1 ||
        copy.value?.documentType !== descriptor.documentType ||
        copy.value?.version !== descriptor.historicalVersion ||
        copy.value?.locale !== locale ||
        typeof copy.value.title !== 'string'
      ) {
        fail('STAGE6_HISTORICAL_LEGAL_INVALID');
      }
      historical.push({
        locale,
        title: copy.value.title,
        body: normalizeHistoricalLegalBody(copy.value),
      });
    }
    legal.push({
      ...descriptor,
      stageArgs: stage.value.args,
      localizations,
      historical,
    });
  }

  const privacy = legal.find((document) => document.documentType === 'privacy');
  const terms = legal.find((document) => document.documentType === 'terms');
  const privacyEffectiveAt = new Date(privacy?.stageArgs?.p_effective_at ?? '');
  const termsEffectiveAt = new Date(terms?.stageArgs?.p_effective_at ?? '');
  if (
    !privacy ||
    !terms ||
    Number.isNaN(privacyEffectiveAt.valueOf()) ||
    Number.isNaN(termsEffectiveAt.valueOf()) ||
    privacyEffectiveAt.toISOString() !== termsEffectiveAt.toISOString()
  ) {
    fail('STAGE6_CURRENT_LEGAL_BUNDLE_INVALID');
  }
  // The live publication tool activates the pair through the post-Stage 6
  // atomic bundle RPC. Deliberately derive this from the frozen version
  // descriptors instead of exposing the obsolete per-document RPC payloads.
  const legalBundle = {
    args: {
      p_privacy_version: privacy.version,
      p_terms_version: terms.version,
    },
    effectiveAt: privacyEffectiveAt.toISOString(),
  };

  const counts = {
    courses: new Set(courses.map((item) => item.slug)).size,
    courseLocalizations: courses.length,
    presentations: courses.length,
    presentationPages: presentationPageCount,
    variants: variantCount,
    questions: questionCount,
    options: optionCount,
    articles: articleSlugs.length,
    articleLocalizations: articles.length,
    currentLegalDocuments: legal.length,
    currentLegalLocalizations: legal.reduce(
      (total, item) => total + item.localizations.length,
      0,
    ),
    historicalLegalLocalizations: legal.reduce(
      (total, item) => total + item.historical.length,
      0,
    ),
  };
  const expectedCounts = {
    courses: STAGE6_EXPECTED.courseCount,
    courseLocalizations: STAGE6_EXPECTED.courseLocalizationCount,
    presentations: STAGE6_EXPECTED.presentationCount,
    presentationPages: STAGE6_EXPECTED.presentationPageCount,
    variants: STAGE6_EXPECTED.variantCount,
    questions: STAGE6_EXPECTED.questionCount,
    options: STAGE6_EXPECTED.optionCount,
    articles: STAGE6_EXPECTED.articleCount,
    articleLocalizations: STAGE6_EXPECTED.articleLocalizationCount,
    currentLegalDocuments: STAGE6_EXPECTED.currentLegalDocumentCount,
    currentLegalLocalizations: STAGE6_EXPECTED.currentLegalLocalizationCount,
    historicalLegalLocalizations: STAGE6_EXPECTED.historicalLegalLocalizationCount,
  };
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
    fail('STAGE6_PUBLICATION_COUNTS_INVALID');
  }
  const artifactManifestHash = canonicalHash(
    [...artifacts.values()]
      .map(({ path: artifactPath, bytes, sha256: digest }) => ({
        path: artifactPath,
        bytes,
        sha256: digest,
      }))
      .sort((left, right) => left.path.localeCompare(right.path, 'en')),
  );
  return {
    batchId: STAGE6_BATCH_ID,
    batchRoot,
    batchHash,
    artifactManifestHash,
    counts,
    courses,
    articles,
    legal,
    legalBundle,
    review: {
      sha256: batchHash,
      independentSemanticReviewSha256:
        review.value.translation?.independentSemanticReview?.sha256 ?? null,
      productionPublished: false,
    },
  };
}
