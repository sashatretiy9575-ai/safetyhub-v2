import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const localeArgument = process.argv.find((value) => value.startsWith('--locales='));
const locales = (localeArgument ? localeArgument.slice('--locales='.length).split(',') : ['kk', 'en', 'zh'])
  .filter((locale, index, values) => ['kk', 'en', 'zh'].includes(locale) && values.indexOf(locale) === index);
if (!locales.length) throw new Error('TARGET_LOCALES_INVALID');
const requireBinaries = process.argv.includes('--require-binaries');
const requireIndependentReview = process.argv.includes('--require-independent-review');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value)).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function presentationAssetFiles(root, extension) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await presentationAssetFiles(absolute, extension));
    else if (entry.isFile() && entry.name === `presentation.${extension}`) files.push(absolute);
  }
  return files.sort();
}

async function validatePresentationBinaries({ locale, slug, expectedSlideCount }) {
  const localeRoot = path.join(stagedRoot, 'presentations', slug, locale);
  const receiptPath = path.join(localeRoot, 'artifact-receipt.json');
  const receipt = await readJson(receiptPath);
  assert(receipt.schemaVersion === 1, `PRESENTATION_RECEIPT_SCHEMA:${slug}:${locale}`);
  assert(receipt.slug === slug && receipt.locale === locale, `PRESENTATION_RECEIPT_ID:${slug}:${locale}`);
  assert(receipt.productionPublished === false, `PRESENTATION_RECEIPT_PUBLISHED:${slug}:${locale}`);
  assert(receipt.qa?.status === 'passed' && receipt.qa?.automatedOnly === true, `PRESENTATION_QA_STATUS:${slug}:${locale}`);

  const expectedSourcePath = `content/source-materials/derived/${slug}/presentation.pptx`;
  const expectedTextMapPath = `content/localizations/staged-2026-09-01/presentations/${slug}/${locale}/text-map.json`;
  assert(receipt.source?.pptx === expectedSourcePath, `PRESENTATION_SOURCE_PATH:${slug}:${locale}`);
  assert(receipt.source?.textMap === expectedTextMapPath, `PRESENTATION_TEXT_MAP_PATH:${slug}:${locale}`);

  const sourcePath = path.resolve(repoRoot, receipt.source.pptx);
  const textMapPath = path.resolve(repoRoot, receipt.source.textMap);
  assert(isWithin(repoRoot, sourcePath) && isWithin(repoRoot, textMapPath), `PRESENTATION_SOURCE_PATH_ESCAPE:${slug}:${locale}`);
  const [sourceBytes, textMapBytes] = await Promise.all([fs.readFile(sourcePath), fs.readFile(textMapPath)]);
  assert(sha256(sourceBytes) === receipt.source.pptxSha256, `PRESENTATION_SOURCE_HASH:${slug}:${locale}`);
  assert(sha256(textMapBytes) === receipt.source.textMapSha256, `PRESENTATION_TEXT_MAP_HASH:${slug}:${locale}`);
  assert(receipt.qa.presentationTextMapSha256 === receipt.source.textMapSha256, `PRESENTATION_QA_TEXT_MAP_HASH:${slug}:${locale}`);

  const kinds = [
    { key: 'pptx', extension: 'pptx', countKey: 'slideCount' },
    { key: 'pdf', extension: 'pdf', countKey: 'pageCount' },
  ];
  for (const { key, extension, countKey } of kinds) {
    const artifact = receipt[key];
    assert(artifact && /^[0-9a-f]{64}$/u.test(artifact.sha256), `PRESENTATION_${key.toUpperCase()}_HASH_FORMAT:${slug}:${locale}`);
    const expectedPath = `content/localizations/staged-2026-09-01/presentations/${slug}/${locale}/assets/${key}/${artifact.sha256}/presentation.${extension}`;
    assert(artifact.path === expectedPath, `PRESENTATION_${key.toUpperCase()}_CONTENT_PATH:${slug}:${locale}`);
    const absolute = path.resolve(repoRoot, artifact.path);
    assert(isWithin(path.join(localeRoot, 'assets', key), absolute), `PRESENTATION_${key.toUpperCase()}_PATH_ESCAPE:${slug}:${locale}`);
    const bytes = await fs.readFile(absolute);
    assert(bytes.length === artifact.byteSize, `PRESENTATION_${key.toUpperCase()}_BYTES:${slug}:${locale}`);
    assert(sha256(bytes) === artifact.sha256, `PRESENTATION_${key.toUpperCase()}_HASH:${slug}:${locale}`);
    assert(artifact[countKey] === expectedSlideCount, `PRESENTATION_${key.toUpperCase()}_COUNT:${slug}:${locale}`);
    const canonicalFiles = await presentationAssetFiles(path.join(localeRoot, 'assets', key), extension);
    assert(canonicalFiles.length === 1, `PRESENTATION_${key.toUpperCase()}_CANONICAL_COUNT:${slug}:${locale}:${canonicalFiles.length}`);
    assert(path.resolve(canonicalFiles[0]) === absolute, `PRESENTATION_${key.toUpperCase()}_CANONICAL_REFERENCE:${slug}:${locale}`);
  }

  assert(receipt.pdf.aspectRatio === '16:9' && receipt.pdf.mimeType === 'application/pdf', `PRESENTATION_PDF_CONTRACT:${slug}:${locale}`);
  assert(receipt.qa.sourceThemePreserved === true, `PRESENTATION_THEME_FIDELITY:${slug}:${locale}`);
  assert(receipt.qa.sourceMasterLayoutHierarchyPreserved === true, `PRESENTATION_MASTER_FIDELITY:${slug}:${locale}`);
  assert(receipt.qa.emptyInheritedPlaceholderCount === 0, `PRESENTATION_EMPTY_PLACEHOLDERS:${slug}:${locale}`);
  assert(receipt.qa.pptxRenderedSlideCount === expectedSlideCount, `PRESENTATION_PPTX_RENDER_COUNT:${slug}:${locale}`);
  assert(receipt.qa.pdfRenderedPageCount === expectedSlideCount, `PRESENTATION_PDF_RENDER_COUNT:${slug}:${locale}`);
  assert(receipt.qa.pageTextLayerCount === expectedSlideCount, `PRESENTATION_PDF_TEXT_LAYER_COUNT:${slug}:${locale}`);
  assert(receipt.qa.localizedTextMismatchCount === 0, `PRESENTATION_TEXT_MISMATCH:${slug}:${locale}`);
  assert(receipt.qa.missingGlyphSentinelCount === 0, `PRESENTATION_GLYPH_FAILURE:${slug}:${locale}`);
  assert(receipt.qa.canvasOverflowCount === 0, `PRESENTATION_CANVAS_OVERFLOW:${slug}:${locale}`);
  assert(receipt.qa.textFrameOverflowCount === 0, `PRESENTATION_TEXT_FRAME_OVERFLOW:${slug}:${locale}`);
  assert(receipt.qa.nonblankPageChecks === expectedSlideCount, `PRESENTATION_NONBLANK_COUNT:${slug}:${locale}`);
  assert(receipt.qa.pdfUnsafeActionCount === 0 && receipt.qa.pdfEmbeddedFileCount === 0, `PRESENTATION_PDF_SAFETY:${slug}:${locale}`);

  return {
    receipt: relativeToRepo(receiptPath),
    pptxSha256: receipt.pptx.sha256,
    pdfSha256: receipt.pdf.sha256,
  };
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function forbiddenKeyPaths(value, current = '$', matches = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeyPaths(item, `${current}[${index}]`, matches));
    return matches;
  }
  if (!value || typeof value !== 'object') return matches;
  for (const [key, child] of Object.entries(value)) {
    const next = `${current}.${key}`;
    if (/(?:correct|answer.?key)/iu.test(key)) matches.push(next);
    forbiddenKeyPaths(child, next, matches);
  }
  return matches;
}

function assessmentTopology(variants) {
  return variants.map((variant) => ({
    id: variant.id,
    variantNumber: variant.variantNumber,
    questions: variant.questions.map((question) => ({
      id: question.id,
      options: question.options.map((option) => option.id),
    })),
  }));
}

function jsonTopology(value) {
  if (Array.isArray(value)) return value.map(jsonTopology);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, jsonTopology(child)]));
  }
  return typeof value;
}

const courseSourceRoot = path.join(repoRoot, 'content', 'snapshots', 'courses');
const courseSlugs = (await fs.readdir(courseSourceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert(courseSlugs.length === 5, `COURSE_COUNT:${courseSlugs.length}`);

let variantCount = 0;
let questionCount = 0;
let optionCount = 0;
for (const slug of courseSlugs) {
  const source = await readJson(path.join(courseSourceRoot, slug, 'course.json'));
  const sourceTopology = assessmentTopology(source.variants);
  assert(source.variants.length === 3, `SOURCE_VARIANTS:${slug}`);
  assert(source.variants.every((variant) => variant.questions.length === 10), `SOURCE_QUESTIONS:${slug}`);
  assert(source.variants.every((variant) => variant.questions.every((question) => question.options.length === 4)), `SOURCE_OPTIONS:${slug}`);
  for (const locale of locales) {
    const base = path.join(stagedRoot, 'courses', slug, locale);
    const assessment = await readJson(path.join(base, 'assessment-import.json'));
    const draft = await readJson(path.join(base, 'course-draft.json'));
    assert(assessment.courseId === source.id && assessment.locale === locale, `ASSESSMENT_ID_LOCALE:${slug}:${locale}`);
    assert(JSON.stringify(assessmentTopology(assessment.questionVariants)) === JSON.stringify(sourceTopology), `ASSESSMENT_TOPOLOGY:${slug}:${locale}`);
    assert(forbiddenKeyPaths(assessment).length === 0, `ASSESSMENT_ANSWER_KEY_LEAK:${slug}:${locale}`);
    assert(draft.courseId === source.id && draft.locale === locale, `COURSE_DRAFT_ID_LOCALE:${slug}:${locale}`);
    assert(draft.answerKeysIncluded === false, `COURSE_DRAFT_ANSWER_FLAG:${slug}:${locale}`);
    assert(typeof draft.sourceAnswerMappingSha256 === 'string' && /^[0-9a-f]{64}$/u.test(draft.sourceAnswerMappingSha256), `COURSE_DRAFT_MAPPING_DIGEST:${slug}:${locale}`);
    const { answerKeysIncluded: _answerKeysIncluded, ...draftWithoutBoundaryReceipt } = draft;
    assert(forbiddenKeyPaths(draftWithoutBoundaryReceipt).length === 0, `COURSE_DRAFT_ANSWER_KEY_LEAK:${slug}:${locale}`);
  }
  variantCount += source.variants.length;
  questionCount += source.variants.reduce((sum, variant) => sum + variant.questions.length, 0);
  optionCount += source.variants.reduce((sum, variant) => sum + variant.questions.reduce((subtotal, question) => subtotal + question.options.length, 0), 0);
}
assert(variantCount === 15 && questionCount === 150 && optionCount === 600, 'COURSE_SOURCE_TOTALS');

const articleSlugs = (await fs.readdir(path.join(repoRoot, 'content', 'articles')))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -5))
  .sort();
assert(articleSlugs.length === 10, `ARTICLE_COUNT:${articleSlugs.length}`);
for (const slug of articleSlugs) {
  let referenceTopology;
  for (const locale of locales) {
    const article = await readJson(path.join(stagedRoot, 'articles', slug, `${locale}.json`));
    assert(article.locale === locale && article.sourceSlug === slug && article.slug === slug, `ARTICLE_ID_LOCALE:${slug}:${locale}`);
    const topology = JSON.stringify(jsonTopology({ ...article, locale: undefined }));
    referenceTopology ??= topology;
    assert(topology === referenceTopology, `ARTICLE_TOPOLOGY:${slug}:${locale}`);
  }
}

const legalDocuments = [
  ['privacy', '1.2'],
  ['terms', '2.2'],
];
for (const [documentType, version] of legalDocuments) {
  let reference;
  for (const locale of locales) {
    const document = await readJson(path.join(stagedRoot, 'legal', documentType, version, `${locale}.json`));
    assert(document.documentType === documentType && document.version === version && document.locale === locale, `LEGAL_ID_LOCALE:${documentType}:${locale}`);
    assert(document.bodyHash === sha256(document.sections), `LEGAL_BODY_HASH:${documentType}:${locale}`);
    const topology = document.sections.map((section) => ({
      id: section.id,
      paragraphCount: section.paragraphs.length,
      itemCount: section.items.length,
      links: (section.links ?? []).map((link) => ({ url: link.url })),
    }));
    reference ??= topology;
    assert(JSON.stringify(topology) === JSON.stringify(reference), `LEGAL_TOPOLOGY:${documentType}:${locale}`);
  }
}

const currentLegalDocuments = [
  ['privacy', '1.3', 'privacy-1.3', 'content/legal/privacy/1.3.ru.json'],
  ['terms', '2.3', 'terms-2.3', 'content/legal/terms/2.3.ru.json'],
];
let currentLegalLocalizationCount = 0;
for (const [documentType, version, bodyRevision, canonicalPath] of currentLegalDocuments) {
  const versionRoot = path.join(stagedRoot, 'legal', documentType, version);
  const canonical = await readJson(path.join(repoRoot, canonicalPath));
  assert(canonical.documentType === documentType && canonical.version === version, `LEGAL_CURRENT_CANONICAL_ID:${documentType}`);
  assert(canonical.bodyRevision === bodyRevision && canonical.locale === 'ru', `LEGAL_CURRENT_CANONICAL_VERSION:${documentType}`);
  assert(canonical.bodySourceSha256 === sha256(canonical.body), `LEGAL_CURRENT_CANONICAL_HASH:${documentType}`);

  const [stagePayload, publishPayload, publicationReceipt] = await Promise.all([
    readJson(path.join(versionRoot, 'stage-rpc.json')),
    readJson(path.join(versionRoot, 'publish-rpc.json')),
    readJson(path.join(versionRoot, 'publication-receipt.json')),
  ]);
  assert(stagePayload.function === 'stage_legal_document_version', `LEGAL_STAGE_RPC:${documentType}`);
  assert(stagePayload.args.p_document_type === documentType, `LEGAL_STAGE_TYPE:${documentType}`);
  assert(stagePayload.args.p_version === version && stagePayload.args.p_body_revision === bodyRevision, `LEGAL_STAGE_VERSION:${documentType}`);
  assert(stagePayload.args.p_effective_at === canonical.effectiveAt, `LEGAL_STAGE_EFFECTIVE_AT:${documentType}`);
  assert(publishPayload.function === 'publish_legal_document_localizations', `LEGAL_PUBLISH_RPC:${documentType}`);
  assert(publishPayload.args.p_document_type === documentType && publishPayload.args.p_version === version, `LEGAL_PUBLISH_ARGS:${documentType}`);
  assert(publishPayload.executeOnlyDuringControlledRelease === true, `LEGAL_PUBLISH_RELEASE_ONLY:${documentType}`);
  assert(publicationReceipt.productionPublished === false, `LEGAL_PUBLICATION_STATE:${documentType}`);
  assert(publicationReceipt.currentPointerActivation === 'deferred-to-controlled-release', `LEGAL_ACTIVATION_GATE:${documentType}`);
  assert(publicationReceipt.publishRpc.executed === false, `LEGAL_PUBLISH_EXECUTION_STATE:${documentType}`);

  const expectedLocales = ['ru', 'kk', 'en', 'zh'];
  const localeDirectories = (await fs.readdir(versionRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert(JSON.stringify(localeDirectories) === JSON.stringify([...expectedLocales].sort()), `LEGAL_CURRENT_LOCALE_DIRECTORIES:${documentType}`);
  assert(publicationReceipt.localizationReceipts.length === 4, `LEGAL_PUBLICATION_LOCALE_COUNT:${documentType}`);
  let referenceTopologySha256 = null;
  const bodyHashes = new Set();
  for (const locale of expectedLocales) {
    const localeRoot = path.join(versionRoot, locale);
    const [savePayload, artifactReceipt, saveBytes] = await Promise.all([
      readJson(path.join(localeRoot, 'save-rpc.json')),
      readJson(path.join(localeRoot, 'artifact-receipt.json')),
      fs.readFile(path.join(localeRoot, 'save-rpc.json')),
    ]);
    const args = savePayload.args;
    assert(savePayload.function === 'save_legal_document_localization', `LEGAL_SAVE_RPC:${documentType}:${locale}`);
    assert(args.p_document_type === documentType && args.p_version === version && args.p_locale === locale, `LEGAL_SAVE_ARGS:${documentType}:${locale}`);
    assert(args.p_complete === true && args.p_body_hash === null, `LEGAL_SAVE_COMPLETION_HASH:${documentType}:${locale}`);
    assert(typeof args.p_title === 'string' && args.p_title.trim().length >= 3, `LEGAL_SAVE_TITLE:${documentType}:${locale}`);
    assert(Array.isArray(args.p_body?.sections) && args.p_body.sections.length === canonical.body.sections.length, `LEGAL_SAVE_SECTIONS:${documentType}:${locale}`);
    for (const section of args.p_body.sections) {
      assert(typeof section.id === 'string' && typeof section.heading === 'string', `LEGAL_SECTION_ID:${documentType}:${locale}`);
      assert(Array.isArray(section.paragraphs) && Array.isArray(section.items) && Array.isArray(section.links), `LEGAL_SECTION_SHAPE:${documentType}:${locale}:${section.id}`);
      for (const link of section.links) {
        assert(typeof link.label === 'string' && link.label.trim(), `LEGAL_LINK_LABEL:${documentType}:${locale}:${section.id}`);
        assert(typeof link.url === 'string' && (link.url.startsWith('https://') || /^\/(?!\/)/u.test(link.url)), `LEGAL_LINK_URL:${documentType}:${locale}:${section.id}`);
      }
    }
    const topologySha256 = sha256(args.p_body.sections.map((section) => ({
      id: section.id,
      paragraphCount: section.paragraphs.length,
      itemCount: section.items.length,
      links: section.links.map((link) => ({ url: link.url })),
    })));
    referenceTopologySha256 ??= topologySha256;
    assert(topologySha256 === referenceTopologySha256, `LEGAL_CURRENT_TOPOLOGY:${documentType}:${locale}`);
    const bodySha256 = sha256(args.p_body);
    bodyHashes.add(bodySha256);
    assert(artifactReceipt.localizedBodySha256 === bodySha256, `LEGAL_CURRENT_BODY_HASH:${documentType}:${locale}`);
    assert(artifactReceipt.topologySha256 === topologySha256, `LEGAL_CURRENT_TOPOLOGY_RECEIPT:${documentType}:${locale}`);
    assert(artifactReceipt.productionPublished === false, `LEGAL_CURRENT_LOCALE_PUBLISHED:${documentType}:${locale}`);
    assert(artifactReceipt.saveRpc.bytes === saveBytes.length && artifactReceipt.saveRpc.sha256 === sha256(saveBytes), `LEGAL_SAVE_RECEIPT_HASH:${documentType}:${locale}`);
    if (locale === 'ru') {
      assert(JSON.stringify(args.p_body) === JSON.stringify(canonical.body), `LEGAL_CURRENT_RU_BODY:${documentType}`);
      assert(bodySha256 === canonical.bodySourceSha256, `LEGAL_CURRENT_RU_HASH:${documentType}`);
      assert(artifactReceipt.automatedOnly === false, `LEGAL_CURRENT_RU_REVIEW_MODE:${documentType}`);
    } else {
      assert(artifactReceipt.automatedOnly === true && artifactReceipt.residualRisk.length > 0, `LEGAL_CURRENT_AUTOMATED_RISK:${documentType}:${locale}`);
    }
    const serialized = JSON.stringify(savePayload);
    assert(!/@auth\.invalid/iu.test(serialized), `LEGAL_SYNTHETIC_EMAIL_LEAK:${documentType}:${locale}`);
    currentLegalLocalizationCount += 1;
  }
  assert(bodyHashes.size === 4, `LEGAL_CURRENT_DISTINCT_LOCALE_HASHES:${documentType}:${bodyHashes.size}`);
}

const expectedSlideCounts = {
  plotnik: 25,
  armaturshchik: 31,
  'lesomontazhnye-raboty': 42,
  biot: 59,
  'pozharnaya-bezopasnost': 41,
};
let localizedSlideCount = 0;
const presentationBinaryReceipts = [];
for (const [slug, expectedSlideCount] of Object.entries(expectedSlideCounts)) {
  let referenceIds;
  for (const locale of locales) {
    const textMap = await readJson(path.join(stagedRoot, 'presentations', slug, locale, 'text-map.json'));
    assert(textMap.slug === slug && textMap.locale === locale && textMap.slideCount === expectedSlideCount, `PRESENTATION_ID_COUNT:${slug}:${locale}`);
    assert(textMap.slides.length === expectedSlideCount, `PRESENTATION_SLIDES:${slug}:${locale}`);
    const ids = textMap.slides.map((slide) => ({
      slide: slide.slide,
      elements: slide.elements.map((element) => ({
        id: element.id,
        cells: (element.cells ?? []).map((cell) => ({ row: cell.row, column: cell.column })),
      })),
    }));
    referenceIds ??= ids;
    assert(JSON.stringify(ids) === JSON.stringify(referenceIds), `PRESENTATION_ELEMENT_TOPOLOGY:${slug}:${locale}`);
    assert(textMap.slides.every((slide) => slide.elements.every((element) => element.translatedText.trim() && /^[0-9a-f]{64}$/u.test(element.sourceTextSha256))), `PRESENTATION_TEXT_EMPTY:${slug}:${locale}`);
    assert(textMap.slides.every((slide) => slide.elements.every((element) => (element.cells ?? []).every((cell) => (
      Number.isInteger(cell.row)
      && cell.row >= 1
      && Number.isInteger(cell.column)
      && cell.column >= 1
      && cell.translatedText.trim()
      && /^[0-9a-f]{64}$/u.test(cell.sourceTextSha256)
    )))), `PRESENTATION_TABLE_CELL_INVALID:${slug}:${locale}`);
    const tableCellCount = textMap.slides.reduce(
      (count, slide) => count + slide.elements.reduce((subtotal, element) => subtotal + (element.cells?.length ?? 0), 0),
      0,
    );
    assert(tableCellCount === (slug === 'biot' ? 15 : 0), `PRESENTATION_TABLE_CELL_COUNT:${slug}:${locale}:${tableCellCount}`);
    if (requireBinaries) {
      presentationBinaryReceipts.push(await validatePresentationBinaries({
        locale,
        slug,
        expectedSlideCount,
      }));
    }
    localizedSlideCount += textMap.slideCount;
  }
}

const reviewPath = path.join(stagedRoot, 'qa', 'automated-review-receipt.json');
const review = await readJson(reviewPath);
assert(review.checks.invariantFailureCount === 0, 'REVIEW_INVARIANT_FAILURES');
assert(review.checks.topologyFailures.length === 0, 'REVIEW_TOPOLOGY_FAILURES');
assert(review.checks.answerKeysIncluded === false && review.checks.sourceStableIdsRetained === true, 'REVIEW_SECURITY_BOUNDARY');
for (const locale of locales) assert(review.translation.targetLocales.includes(locale), `REVIEW_LOCALE_MISSING:${locale}`);
const independentReviewLink = review.translation.independentSemanticReview;
if (independentReviewLink?.status === 'passed') {
  const independentPath = path.join(stagedRoot, independentReviewLink.path);
  const independentBytes = await fs.readFile(independentPath);
  const independent = JSON.parse(independentBytes.toString('utf8'));
  assert(sha256(independentBytes) === independentReviewLink.sha256 && independentBytes.length === independentReviewLink.bytes, 'INDEPENDENT_REVIEW_RECEIPT_HASH');
  assert(independent.status === 'passed' && independent.automatedOnly === true && independent.noHumanApproval === true, 'INDEPENDENT_REVIEW_STATUS');
  assert(!/google translate/iu.test(independent.providerFamily ?? ''), 'INDEPENDENT_REVIEW_PROVIDER_FAMILY');
  assert(Array.isArray(independent.validationFailures) && independent.validationFailures.length === 0, 'INDEPENDENT_REVIEW_VALIDATION_FAILURES');
  assert(Array.isArray(independent.unresolvedMaterialFindings) && independent.unresolvedMaterialFindings.length === 0, 'INDEPENDENT_REVIEW_UNRESOLVED_FINDINGS');
  assert(independent.acceptedOverrideFileSha256 === review.translation.overrideFileSha256, 'INDEPENDENT_REVIEW_OVERRIDE_HASH');
} else if (requireIndependentReview) {
  throw new Error('INDEPENDENT_SEMANTIC_REVIEW_REQUIRED');
}
const hashFailures = [];
for (const artifact of review.artifacts) {
  const absolute = path.join(stagedRoot, artifact.path);
  const bytes = await fs.readFile(absolute);
  if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) hashFailures.push(artifact.path);
}
assert(hashFailures.length === 0, `REVIEW_ARTIFACT_HASHES:${hashFailures.length}`);

console.log(JSON.stringify({
  ok: true,
  locales,
  courses: courseSlugs.length,
  variants: variantCount,
  questions: questionCount,
  options: optionCount,
  articles: articleSlugs.length,
  historicalLegalDocuments: legalDocuments.length,
  currentLegalDocuments: currentLegalDocuments.length,
  currentLegalLocalizations: currentLegalLocalizationCount,
  presentationDecks: Object.keys(expectedSlideCounts).length,
  localizedSlides: localizedSlideCount,
  presentationBinaryReceipts: presentationBinaryReceipts.length,
  presentationBinariesRequired: requireBinaries,
  independentReviewRequired: requireIndependentReview,
  independentReviewStatus: independentReviewLink?.status ?? 'missing',
  manifestArtifacts: review.artifacts.length,
}));
