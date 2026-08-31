import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return path.resolve(root, value);
}

const snapshotRoot = argumentValue(
  '--snapshot-root',
  path.join(root, 'content', 'snapshots', 'courses'),
);
const mediaSnapshotRoot = argumentValue(
  '--media-root',
  path.join(root, 'content', 'snapshots', 'media'),
);
const articlesRoot = argumentValue('--articles-root', path.join(root, 'content', 'articles'));
const initialImport = process.argv.includes('--initial-import');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const INITIAL = {
  catalogVersion: '2026-08-25-new-five-course-catalog',
  slugs: [
    'plotnik',
    'armaturshchik',
    'lesomontazhnye-raboty',
    'biot',
    'pozharnaya-bezopasnost',
  ],
  pageCounts: {
    plotnik: 25,
    armaturshchik: 31,
    'lesomontazhnye-raboty': 42,
    biot: 59,
    'pozharnaya-bezopasnost': 41,
  },
  sourcePresentationHashes: {
    plotnik: 'd3b84cbe64a5376c61168ee798b5130c4e593ba39c302f785a13293125766948',
    armaturshchik: '480cd55c460114d9210fae0a1b7232a71345587c676cdecc644351ec2497ffbe',
    'lesomontazhnye-raboty': '7b8b4b247ba1fe3ff3480ded219417ece9710daa0fd12875f81db10d058228d6',
    biot: 'aaca0cb2b612774e7d574f66d0bf2c103536333bb575dca43db4cf657b601c8f',
    'pozharnaya-bezopasnost': 'eb0c64b3aa83a3d63d74631d899def9f7683d06858baca516cc8fc254b46d68a',
  },
  sourceDocumentHash: '3b36bba9f031c233cd10a4a80e1f7dd2a89af523b5df2145056dc7366086ce00',
  totals: {
    courseCount: 5,
    presentationCount: 5,
    presentationPageCount: 198,
    variantCount: 15,
    questionCount: 150,
    optionCount: 600,
    correctAnswerCount: 150,
  },
  answerKeyMatrix: {
    plotnik: [
      [...'ВАГБВГАВБГ'],
      [...'БГАВБГВАГБ'],
      [...'АВБГВАГБАВ'],
    ],
    armaturshchik: [
      [...'ГБВАГВБГАВ'],
      [...'АБГВБАГБВГ'],
      [...'ВАБВГАВБГА'],
    ],
    'lesomontazhnye-raboty': [
      [...'АГВБГАВГБВ'],
      [...'ВБГАБГВБАГ'],
      [...'БВАГВАБВГА'],
    ],
    biot: [
      [...'БВГАВГБАГВ'],
      [...'ГАБГВБАГВБ'],
      [...'АГВБАВГАБВ'],
    ],
    'pozharnaya-bezopasnost': [
      [...'ГВАБВГАВГБ'],
      [...'БАГБВГБАГВ'],
      [...'ВБАВГБАВГА'],
    ],
  },
};

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sortJson(value) {
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

function canonicalHash(value) {
  return sha256(Buffer.from(JSON.stringify(sortJson(value)), 'utf8'));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function databaseContentProjection(course) {
  return {
    slug: course.slug,
    title: course.title,
    description: course.description,
    icon: course.icon,
    displayOrder: course.displayOrder,
    presentationSha256: course.presentation.sha256,
    presentationPageCount: course.presentation.pageCount,
    durationMinutes: course.policy.durationMinutes,
    passScore: course.policy.passScore,
    attemptsPerCalendarDay: course.policy.attemptsPerCalendarDay,
    attemptResetTimezone: course.policy.resetTimezone,
    questionVariants: course.variants,
    seo: course.seo,
    jurisdiction: course.jurisdiction,
    effectiveDate: course.effectiveDate,
    sources: course.sources,
  };
}

function registerUuid(identifiers, id, context) {
  if (typeof id !== 'string' || !uuidPattern.test(id) || identifiers.has(id)) {
    throw new Error(`${context}: invalid or duplicate UUID ${String(id)}`);
  }
  identifiers.add(id);
}

const catalog = await readJson(path.join(snapshotRoot, 'catalog.json'));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.courses) || catalog.courses.length === 0) {
  throw new Error('Catalog must contain at least one schema-v1 course');
}

const orderedCatalogCourses = [...catalog.courses].sort(
  (left, right) => left.displayOrder - right.displayOrder,
);
if (JSON.stringify(orderedCatalogCourses) !== JSON.stringify(catalog.courses)) {
  throw new Error('Catalog courses must be stored in display order');
}
const catalogSlugs = catalog.courses.map((course) => course.slug);
if (
  new Set(catalogSlugs).size !== catalogSlugs.length ||
  catalogSlugs.some((slug) => typeof slug !== 'string' || !slugPattern.test(slug))
) {
  throw new Error('Catalog contains duplicate or invalid slugs');
}
const catalogOrders = catalog.courses.map((course) => course.displayOrder);
if (
  new Set(catalogOrders).size !== catalogOrders.length ||
  catalogOrders.some((order) => !integerInRange(order, 1, 1000))
) {
  throw new Error('Catalog contains duplicate or invalid display orders');
}

const snapshotDirectories = (await fs.readdir(snapshotRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(snapshotDirectories) !== JSON.stringify([...catalogSlugs].sort())) {
  throw new Error('Snapshot directories do not exactly match catalog.courses');
}

const totals = {
  courseCount: 0,
  presentationCount: 0,
  presentationPageCount: 0,
  variantCount: 0,
  questionCount: 0,
  optionCount: 0,
  correctAnswerCount: 0,
};
const identifiers = new Set();
const derivedKeys = {};

for (const catalogEntry of catalog.courses) {
  const slug = catalogEntry.slug;
  const courseDir = path.join(snapshotRoot, slug);
  const course = await readJson(path.join(courseDir, 'course.json'));
  const manifest = await readJson(path.join(courseDir, 'presentation-manifest.json'));
  const pdf = await fs.readFile(path.join(courseDir, 'presentation.pdf'));
  const thumbnail = await fs.readFile(path.join(courseDir, 'thumbnail.webp'));

  if (
    course.schemaVersion !== 1 ||
    course.slug !== slug ||
    course.id !== catalogEntry.id ||
    course.displayOrder !== catalogEntry.displayOrder ||
    course.title !== catalogEntry.title
  ) {
    throw new Error(`${slug}: course and catalog metadata differ`);
  }
  if (
    typeof course.title !== 'string' ||
    course.title.trim().length < 3 ||
    course.title.length > 200 ||
    typeof course.description !== 'string' ||
    course.description.length > 1000 ||
    typeof course.icon !== 'string' ||
    course.icon.length < 1 ||
    course.icon.length > 40 ||
    !course.seo ||
    typeof course.seo !== 'object' ||
    Array.isArray(course.seo) ||
    !Array.isArray(course.sources)
  ) {
    throw new Error(`${slug}: invalid course metadata`);
  }

  const policy = course.policy;
  if (
    !policy ||
    !integerInRange(policy.durationMinutes, 1, 120) ||
    !integerInRange(policy.questionCount, 1, 100) ||
    !integerInRange(policy.variantCount, 1, 10) ||
    !integerInRange(policy.passScore, 1, policy.questionCount) ||
    !integerInRange(policy.attemptsPerCalendarDay, 1, 50) ||
    !validTimeZone(policy.resetTimezone)
  ) {
    throw new Error(`${slug}: policy is outside supported ranges`);
  }

  if (
    manifest.schemaVersion !== 1 ||
    manifest.slug !== slug ||
    manifest.file !== 'presentation.pdf' ||
    manifest.thumbnail !== 'thumbnail.webp' ||
    manifest.mimeType !== 'application/pdf' ||
    manifest.aspectRatio !== '16:9' ||
    course.presentation.file !== manifest.file ||
    course.presentation.thumbnail !== manifest.thumbnail ||
    course.presentation.mimeType !== manifest.mimeType ||
    course.presentation.aspectRatio !== manifest.aspectRatio ||
    !integerInRange(course.presentation.pageCount, 1, 200) ||
    typeof course.presentation.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(course.presentation.sha256) ||
    typeof course.presentation.thumbnailSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(course.presentation.thumbnailSha256) ||
    pdf.length === 0 ||
    pdf.length > 25 * 1024 * 1024 ||
    pdf.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    thumbnail.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    thumbnail.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error(`${slug}: invalid learner presentation assets`);
  }
  if (
    sha256(pdf) !== course.presentation.sha256 ||
    sha256(pdf) !== manifest.sha256 ||
    pdf.length !== course.presentation.byteSize ||
    pdf.length !== manifest.byteSize ||
    sha256(thumbnail) !== course.presentation.thumbnailSha256 ||
    sha256(thumbnail) !== manifest.thumbnailSha256 ||
    course.presentation.pageCount !== manifest.pageCount ||
    manifest.pages.length !== manifest.pageCount ||
    manifest.renderedPageCount !== manifest.pageCount ||
    manifest.renderSize?.width !== 1600 ||
    manifest.renderSize?.height !== 900 ||
    course.presentation.notesIncluded !== false ||
    manifest.notesIncluded !== false
  ) {
    throw new Error(`${slug}: presentation manifest mismatch`);
  }
  if (
    !(
      manifest.finalPageCta === null ||
      (typeof manifest.finalPageCta === 'string' &&
        manifest.finalPageCta.length > 0 &&
        manifest.finalPageCta.length <= 500)
    ) ||
    (initialImport && manifest.finalPageCta !== 'Нажмите «Начать тест»')
  ) {
    throw new Error(`${slug}: final-page CTA receipt is invalid`);
  }
  if (
    !manifest.pages.every(
      (page, index) =>
        page.pageNumber === index + 1 &&
        page.width === 1600 &&
        page.height === 900 &&
        integerInRange(page.textCharacters, 1, 100_000) &&
        typeof page.pngSha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(page.pngSha256) &&
        page.colorStdevTotal > 0.5,
    )
  ) {
    throw new Error(`${slug}: a rendered page is blank, lacks a text layer, or is not 16:9`);
  }
  if (
    manifest.validation?.automated?.status !== 'passed' ||
    manifest.validation?.safety?.status !== 'passed' ||
    manifest.validation?.safety?.encrypted !== false ||
    manifest.validation?.safety?.unsafeActionCount !== 0 ||
    manifest.validation?.safety?.embeddedFileCount !== 0 ||
    manifest.validation?.visual?.status !== 'passed' ||
    manifest.validation?.visual?.reviewedPageCount !== manifest.pageCount ||
    manifest.validation?.visual?.contactSheetCount !== Math.ceil(manifest.pageCount / 12) ||
    typeof manifest.validation?.visual?.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.validation.visual.reviewedAt))
  ) {
    throw new Error(`${slug}: PDF QA receipt is incomplete`);
  }

  const expectedDbHash = canonicalHash(databaseContentProjection(course));
  if (
    course.dbContentHash !== expectedDbHash ||
    course.contentHash !== expectedDbHash ||
    catalogEntry.dbContentHash !== expectedDbHash ||
    catalogEntry.contentHash !== expectedDbHash
  ) {
    throw new Error(`${slug}: DB content hash mismatch`);
  }
  const snapshotProjection = structuredClone(course);
  delete snapshotProjection.contentHash;
  delete snapshotProjection.snapshotContentHash;
  if (
    course.snapshotContentHash !== canonicalHash(snapshotProjection) ||
    catalogEntry.snapshotContentHash !== course.snapshotContentHash
  ) {
    throw new Error(`${slug}: full snapshot hash mismatch`);
  }
  if (
    catalogEntry.presentationSha256 !== course.presentation.sha256 ||
    catalogEntry.pageCount !== course.presentation.pageCount
  ) {
    throw new Error(`${slug}: catalog presentation receipt mismatch`);
  }

  registerUuid(identifiers, course.id, `${slug} course`);
  registerUuid(identifiers, course.presentation.id, `${slug} presentation`);
  if (!Array.isArray(course.variants) || course.variants.length !== policy.variantCount) {
    throw new Error(`${slug}: declared and actual variant counts differ`);
  }

  const keyVariants = [];
  for (let variantIndex = 0; variantIndex < course.variants.length; variantIndex += 1) {
    const variant = course.variants[variantIndex];
    registerUuid(identifiers, variant.id, `${slug} variant ${variantIndex + 1}`);
    if (
      JSON.stringify(Object.keys(variant).sort()) !== JSON.stringify(['id', 'questions', 'variantNumber']) ||
      variant.variantNumber !== variantIndex + 1 ||
      !Array.isArray(variant.questions) ||
      variant.questions.length !== policy.questionCount
    ) {
      throw new Error(`${slug}: malformed variant ${variantIndex + 1}`);
    }
    const letters = [];
    for (let questionIndex = 0; questionIndex < variant.questions.length; questionIndex += 1) {
      const question = variant.questions[questionIndex];
      registerUuid(identifiers, question.id, `${slug} question ${questionIndex + 1}`);
      if (
        JSON.stringify(Object.keys(question).sort()) !==
          JSON.stringify(['correctOptionId', 'displayOrder', 'explanation', 'id', 'options', 'text']) ||
        question.displayOrder !== questionIndex + 1 ||
        !Array.isArray(question.options) ||
        question.options.length !== 4 ||
        typeof question.text !== 'string' ||
        question.text.trim().length < 3 ||
        question.text.length > 2000 ||
        /<\s*script/iu.test(question.text) ||
        /из старой презентации/iu.test(question.text) ||
        typeof question.explanation !== 'string' ||
        question.explanation.length > 2000
      ) {
        throw new Error(`${slug}: malformed question ${questionIndex + 1}`);
      }
      const optionIds = [];
      for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
        const option = question.options[optionIndex];
        registerUuid(identifiers, option.id, `${slug} option ${optionIndex + 1}`);
        if (
          JSON.stringify(Object.keys(option).sort()) !== JSON.stringify(['displayOrder', 'id', 'text']) ||
          option.displayOrder !== optionIndex + 1 ||
          typeof option.text !== 'string' ||
          option.text.trim().length === 0 ||
          option.text.length > 1000 ||
          /<\s*script/iu.test(option.text)
        ) {
          throw new Error(`${slug}: malformed option ${optionIndex + 1}`);
        }
        optionIds.push(option.id);
      }
      const correctIndex = optionIds.indexOf(question.correctOptionId);
      if (correctIndex < 0) throw new Error(`${slug}: correct answer does not belong to its question`);
      letters.push(['А', 'Б', 'В', 'Г'][correctIndex]);
      if (initialImport && question.explanation !== '') {
        throw new Error(`${slug}: initial source contains no explanations`);
      }
    }
    keyVariants.push(letters);
  }
  derivedKeys[slug] = keyVariants;

  totals.courseCount += 1;
  totals.presentationCount += 1;
  totals.presentationPageCount += manifest.pageCount;
  totals.variantCount += course.variants.length;
  totals.questionCount += course.variants.reduce((sum, variant) => sum + variant.questions.length, 0);
  totals.optionCount += course.variants.reduce(
    (variantSum, variant) =>
      variantSum + variant.questions.reduce((questionSum, question) => questionSum + question.options.length, 0),
    0,
  );
  totals.correctAnswerCount += course.variants.reduce((sum, variant) => sum + variant.questions.length, 0);

  if (initialImport) {
    if (
      policy.durationMinutes !== 15 ||
      policy.passScore !== 7 ||
      policy.questionCount !== 10 ||
      policy.variantCount !== 3 ||
      policy.attemptsPerCalendarDay !== 8 ||
      policy.resetTimezone !== 'Asia/Oral' ||
      course.presentation.pageCount !== INITIAL.pageCounts[slug] ||
      course.sourceMaterials?.presentation?.sha256 !== INITIAL.sourcePresentationHashes[slug] ||
      course.sourceMaterials?.tests?.sha256 !== INITIAL.sourceDocumentHash
    ) {
      throw new Error(`${slug}: initial-import receipt mismatch`);
    }
  }
}

if (JSON.stringify(totals) !== JSON.stringify(catalog.totals)) {
  throw new Error(`Catalog totals mismatch: ${JSON.stringify(totals)}`);
}
const expectedCatalogChecksum = sha256(
  Buffer.from(catalog.courses.map((course) => course.dbContentHash).join(','), 'utf8'),
);
if (catalog.catalogChecksum !== expectedCatalogChecksum) {
  throw new Error('Catalog checksum does not match the DB activation algorithm');
}
const catalogProjection = structuredClone(catalog);
delete catalogProjection.catalogHash;
if (catalog.catalogHash !== canonicalHash(catalogProjection)) {
  throw new Error('Catalog snapshot hash mismatch');
}

if (initialImport) {
  if (
    catalog.catalogVersion !== INITIAL.catalogVersion ||
    JSON.stringify(catalogSlugs) !== JSON.stringify(INITIAL.slugs) ||
    JSON.stringify(totals) !== JSON.stringify(INITIAL.totals) ||
    JSON.stringify(derivedKeys) !== JSON.stringify(INITIAL.answerKeyMatrix) ||
    JSON.stringify(catalog.answerKeyMatrix) !== JSON.stringify(INITIAL.answerKeyMatrix) ||
    catalog.sourceDocument?.sha256 !== INITIAL.sourceDocumentHash ||
    catalog.approvedWordingCorrection?.legacyReferenceRemoved !== true
  ) {
    throw new Error('Initial five-course import does not match its approved control manifest');
  }
}

const mediaManifest = await readJson(path.join(mediaSnapshotRoot, 'manifest.json'));
const mediaProjection = {
  schemaVersion: mediaManifest.schemaVersion,
  bucket: mediaManifest.bucket,
  assets: mediaManifest.assets,
};
if (
  mediaManifest.schemaVersion !== 1 ||
  mediaManifest.bucket !== 'content-media' ||
  !Array.isArray(mediaManifest.assets) ||
  mediaManifest.manifestHash !== canonicalHash(mediaProjection)
) {
  throw new Error('Public content media manifest is invalid');
}
const mediaIds = new Set();
const mediaStorageKeys = new Set();
const mediaHashes = new Set();
for (const asset of mediaManifest.assets) {
  if (
    !asset ||
    !uuidPattern.test(asset.id) ||
    !/^[0-9a-f]{2}\/[0-9a-f]{64}[.]webp$/u.test(asset.storageKey) ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
    asset.file !== `${asset.sha256}.webp` ||
    asset.mimeType !== 'image/webp' ||
    !integerInRange(asset.width, 1, 1600) ||
    !integerInRange(asset.height, 1, 1600) ||
    !integerInRange(asset.byteSize, 1, 2 * 1024 * 1024) ||
    mediaIds.has(asset.id) ||
    mediaStorageKeys.has(asset.storageKey) ||
    mediaHashes.has(asset.sha256)
  ) {
    throw new Error(`Invalid public content media asset: ${asset?.id ?? 'unknown'}`);
  }
  const bytes = await fs.readFile(path.join(mediaSnapshotRoot, asset.file));
  if (bytes.length !== asset.byteSize || sha256(bytes) !== asset.sha256) {
    throw new Error(`Public content media file mismatch: ${asset.id}`);
  }
  mediaIds.add(asset.id);
  mediaStorageKeys.add(asset.storageKey);
  mediaHashes.add(asset.sha256);
}
const referencedMediaIds = new Set();
for (const articleFile of (await fs.readdir(articlesRoot)).filter((file) => file.endsWith('.json'))) {
  const article = await readJson(path.join(articlesRoot, articleFile));
  for (const match of JSON.stringify(article).matchAll(
    /\/api\/content-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/giu,
  )) {
    referencedMediaIds.add(match[1].toLowerCase());
  }
}
if (
  JSON.stringify([...referencedMediaIds].sort()) !== JSON.stringify([...mediaIds].sort())
) {
  throw new Error('Public article media snapshot does not match published article references');
}
const mediaFiles = (await fs.readdir(mediaSnapshotRoot)).sort();
const expectedMediaFiles = ['manifest.json', ...mediaManifest.assets.map((asset) => asset.file)].sort();
if (JSON.stringify(mediaFiles) !== JSON.stringify(expectedMediaFiles)) {
  throw new Error('Public content media snapshot contains missing or stale files');
}

console.log(
  JSON.stringify(
    {
      valid: true,
      mode: initialImport ? 'initial-import' : 'dynamic-catalog',
      totals,
      uniqueIdentifiers: identifiers.size,
      mediaAssetCount: mediaManifest.assets.length,
      catalogHash: catalog.catalogHash,
      catalogChecksum: catalog.catalogChecksum,
    },
    null,
    2,
  ),
);
