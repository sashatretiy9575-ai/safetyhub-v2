// Read-only readiness proof for the September 2026 course batch on the LOCAL Supabase stand.
//
// The publisher's receipt records what was SENT. This script proves what the database and the
// storage bucket actually HOLD — per course and per language — against the reviewed files in
// content/course-batch-2026-09, and that nothing a learner can read carries an answer key.
//
// Usage: node --env-file=.env.local scripts/verify-course-batch-local.mjs [--sql] [--strict]
//   --sql     also counts the private answer keys through a read-only psql session in Docker
//   --strict  treats advisory warnings as failures
//
// Safety: refuses any Supabase host other than 127.0.0.1/localhost, and every HTTP request goes
// through a fetch wrapper that only lets GET/HEAD to that one origin through. PostgREST selects,
// `rpc(..., { get: true })` on STABLE functions and storage downloads are all GET, so a write
// cannot leave this process even by mistake.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import { getCourseCoverImage } from '../lib/content/course-cover-images.ts';
import { contentSeoSchema, defaultContentSeo } from '../lib/validation/content-seo.ts';

// Kept local on purpose: a verifier must not import the module that can publish. The unit test
// pins these to the publisher's own lists so the two cannot drift apart.
export const VERIFIED_SLUGS = ['svarshchik', 'promyshlennaya-bezopasnost'];
export const VERIFIED_LOCALES = ['ru', 'kk', 'en', 'zh'];
export const CHECK_IDS = [
  'publication',
  'text-seo',
  'presentation',
  'cover',
  'questions',
  'no-answer-keys',
  'no-russian-leftovers',
];

const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost'];
const LOCAL_DATABASE_CONTAINER = 'supabase_db_podkjjguhhdiecrgznoa';
const PRESENTATION_BUCKET = 'course-presentations';
const REQUEST_TIMEOUT_MS = 60_000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_ROOT = path.join(REPOSITORY_ROOT, 'content', 'course-batch-2026-09');
const OUTPUT_PATH = path.join(REPOSITORY_ROOT, 'artifacts', 'course-batch-readiness-local.json');
const SEO_TEXT_FIELDS = ['title', 'description', 'ogTitle', 'ogDescription'];
const SEO_FIELDS = [...SEO_TEXT_FIELDS, 'ogImage', 'indexable'];
// What the public page silently substitutes when a stored SEO block is empty or invalid.
const RUSSIAN_DEFAULT_SEO = defaultContentSeo('', '');
const RUSSIAN_DEFAULT_MARKER = 'материал safetyhub';
const CYRILLIC_SHARE_LIMIT = 0.3;
const KAZAKH_IDENTICAL_MIN_LENGTH = 40;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clip = (value, length = 70) => {
  const text = String(value);
  return JSON.stringify(text.length > length ? `${text.slice(0, length)}…` : text);
};

export function assertLocalSupabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new Error('LOCAL_SUPABASE_URL_REQUIRED');
  }
  // `hostname` is compared exactly: `127.0.0.1.example.com` and `localhost@remote` must not pass.
  if (
    !LOCAL_HOSTNAMES.includes(parsed.hostname) ||
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('LOCAL_SUPABASE_ONLY');
  }
  return parsed;
}

/** Lets only GET/HEAD to one origin through; everything else is refused before it is sent. */
export function createReadOnlyFetch(allowedOrigin, baseFetch = fetch) {
  return async (input, init = {}) => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    const url = new URL(request ? request.url : String(input));
    if (url.origin !== allowedOrigin) throw new Error('READ_ONLY_FETCH_FOREIGN_ORIGIN');
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error(`READ_ONLY_FETCH_METHOD_REFUSED:${method}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function isAnswerKeyField(name) {
  const normalized = name.replace(/[_-]/gu, '').toLowerCase();
  return (
    ['correct', 'iscorrect', 'answerkey', 'answerkeys'].includes(normalized) ||
    /^correct(?:option|position|answer|index)/u.test(normalized)
  );
}

/** JSON paths of every field that names a correct answer. Values are never returned. */
export function findAnswerKeyPaths(value, base = '$') {
  const found = [];
  const visit = (node, at) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${at}[${index}]`));
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (isAnswerKeyField(key)) found.push(`${at}.${key}`);
        visit(child, `${at}.${key}`);
      }
    } else if (typeof node === 'string' && /correct_?option_?id/iu.test(node)) {
      // A keyed bank serialised into a string column would slip past a key-name walk.
      found.push(`${at} (embedded text)`);
    }
  };
  visit(value, base);
  return found;
}

export function cyrillicShare(text) {
  let letters = 0;
  let cyrillic = 0;
  for (const character of String(text)) {
    if (!/\p{L}/u.test(character)) continue;
    letters += 1;
    if (/\p{Script=Cyrillic}/u.test(character)) cyrillic += 1;
  }
  return letters === 0 ? 0 : cyrillic / letters;
}

/**
 * Russian text left in a translation. English and Chinese have no business being a third
 * Cyrillic; Kazakh is Cyrillic itself, so only a long string identical to its Russian
 * counterpart is evidence (short ones are abbreviations and proper names).
 */
export function russianLeftovers(locale, strings, russianStrings) {
  if (locale === 'ru') return [];
  const leftovers = [];
  for (const [at, text] of strings) {
    if (locale === 'kk') {
      if ([...text].length >= KAZAKH_IDENTICAL_MIN_LENGTH && russianStrings.get(at) === text) {
        leftovers.push(`${at}: identical to Russian ${clip(text)}`);
      }
    } else if (cyrillicShare(text) > CYRILLIC_SHARE_LIMIT) {
      leftovers.push(`${at}: ${Math.round(cyrillicShare(text) * 100)}% Cyrillic ${clip(text)}`);
    }
  }
  return leftovers;
}

/**
 * Russian rows keep the revision's own shape (`position`), translated rows the import
 * projection (`displayOrder`). A learner sees identity, order and wording, so only those count.
 */
export function comparableQuestions(questions) {
  const ordered = (items) =>
    [...(Array.isArray(items) ? items : [])]
      .map((item, index) => ({
        item,
        order: Number(item?.position ?? item?.displayOrder ?? index + 1),
      }))
      .sort((left, right) => left.order - right.order)
      .map(({ item }) => item);
  return ordered(questions).map((question) => ({
    id: question?.id,
    text: question?.text,
    options: ordered(question?.options).map((option) => ({ id: option?.id, text: option?.text })),
  }));
}

export function createCheck() {
  const problems = [];
  return {
    problems,
    facts: {},
    expect(condition, problem) {
      if (!condition) problems.push(problem);
      return Boolean(condition);
    },
  };
}

function sameJson(left, right) {
  const sort = (value) =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sort(value[key])]),
          )
        : value;
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

function isWebp(bytes) {
  return (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

/** The publisher's projection of a deck's sources: only linked entries, title and url. */
function publishedSources(deck) {
  return (deck.sources ?? [])
    .filter((source) => source.url && source.title)
    .map(({ title, url }) => `${title}\n${url}`)
    .sort();
}

async function loadDiskEntry(contentRoot, slug, locale, review) {
  const directory = path.join(contentRoot, slug, locale);
  const [deckBytes, assessmentBytes, pdf, thumbnail] = await Promise.all([
    readFile(path.join(directory, 'deck.json')),
    readFile(path.join(directory, 'assessment.json')),
    readFile(path.join(directory, 'presentation.pdf')),
    readFile(path.join(directory, 'thumbnail.webp')),
  ]);
  const receipt = review.entries?.find((entry) => entry.slug === slug && entry.locale === locale);
  return {
    deck: JSON.parse(deckBytes.toString('utf8')),
    assessment: JSON.parse(assessmentBytes.toString('utf8')),
    pdfSha256: sha256(pdf),
    pdfByteSize: pdf.length,
    pdfPageCount: (await PDFDocument.load(pdf)).getPageCount(),
    thumbnailSha256: sha256(thumbnail),
    // The files compared against must be the reviewed ones, or a match proves nothing.
    reviewed:
      Boolean(receipt) &&
      receipt.deckSha256 === sha256(deckBytes) &&
      receipt.assessmentSha256 === sha256(assessmentBytes) &&
      receipt.pdfSha256 === sha256(pdf) &&
      receipt.visual === 'passed' &&
      receipt.semantic === 'passed',
  };
}

function createReader(client) {
  return async (table, columns, column, values) => {
    const { data, error } = await client.from(table).select(columns).in(column, values);
    if (error || !Array.isArray(data)) {
      throw new Error(`READ_FAILED:${table}:${error?.code ?? ''}:${error?.message ?? 'no rows'}`);
    }
    return data;
  };
}

async function readState(service) {
  const read = createReader(service);
  const tests = await read(
    'tests',
    'id,slug,status,current_revision_id,content_version,content_hash',
    'slug',
    VERIFIED_SLUGS,
  );
  const testIds = tests.map((test) => test.id);
  const revisionIds = tests.map((test) => test.current_revision_id).filter(Boolean);
  const [
    drafts,
    revisions,
    liveLocalizations,
    draftLocalizations,
    variants,
    variantLocalizations,
    liveMappings,
    draftMappings,
  ] = await Promise.all([
    read('course_drafts', 'test_id,content_hash,draft_version,presentation_id', 'test_id', testIds),
    read(
      'test_revisions',
      'id,test_id,slug,version,content_hash,published_at,duration_minutes,pass_score,question_count,attempts_per_calendar_day,attempt_reset_timezone,presentation_id,questions,content,seo,sources',
      'id',
      revisionIds,
    ),
    read(
      'test_revision_localizations',
      'revision_id,locale,title,description,content,seo,sources,content_hash,translation_qa,published_at',
      'revision_id',
      revisionIds,
    ),
    read(
      'course_draft_localizations',
      'test_id,locale,title,description,content,question_variants,seo,sources,content_hash,reviewed_content_hash,translation_qa,status,draft_version',
      'test_id',
      testIds,
    ),
    read(
      'test_revision_variants',
      'id,revision_id,stable_id,variant_number,question_count,questions',
      'revision_id',
      revisionIds,
    ),
    read(
      'test_revision_variant_localizations',
      'revision_id,variant_id,locale,questions,explanations,question_count,structure_hash',
      'revision_id',
      revisionIds,
    ),
    read(
      'test_revision_presentations',
      'revision_id,locale,presentation_id',
      'revision_id',
      revisionIds,
    ),
    read('course_draft_presentations', 'test_id,locale,presentation_id', 'test_id', testIds),
  ]);
  const presentations = await read(
    'course_presentations',
    'id,course_id,locale,status,sha256,page_count,byte_size,mime_type,storage_bucket,storage_path,thumbnail_path',
    'id',
    [...new Set(liveMappings.map((mapping) => mapping.presentation_id))],
  );
  return {
    tests,
    drafts,
    revisions,
    liveLocalizations,
    draftLocalizations,
    variants,
    variantLocalizations,
    liveMappings,
    draftMappings,
    presentations,
  };
}

async function download(service, objectPath) {
  const { data, error } = await service.storage.from(PRESENTATION_BUCKET).download(objectPath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** What the anonymous site reads. Both functions are STABLE, so GET is enough to call them. */
async function readPublic(anonymous, name, args) {
  const { data, error } = await anonymous.rpc(name, args, { get: true });
  return error || !data || typeof data !== 'object' ? null : data;
}

export function checkPublication({
  check,
  test,
  draft,
  revision,
  live,
  draftLocalization,
  mappings,
  listed,
  deck,
  locale,
}) {
  check.expect(test.status === 'published', `tests.status is ${clip(test.status)}`);
  check.expect(Boolean(test.current_revision_id), 'tests.current_revision_id is empty');
  check.expect(
    revision && revision.test_id === test.id && revision.slug === test.slug,
    'the current revision is missing or belongs to another course',
  );
  const publishedAt = Date.parse(live?.published_at ?? '');
  check.expect(Boolean(live), 'no test_revision_localizations row');
  check.expect(
    Number.isFinite(publishedAt) && publishedAt <= Date.now() + 60_000,
    `publication timestamp is ${clip(live?.published_at ?? 'missing')}`,
  );
  check.expect(
    draftLocalization?.status === 'complete',
    `draft status is ${clip(draftLocalization?.status ?? 'missing')}`,
  );
  check.expect(
    Boolean(draftLocalization?.content_hash) &&
      draftLocalization.reviewed_content_hash === draftLocalization.content_hash,
    'draft is not reviewed at its current hash',
  );
  // The catalogue's own «Есть черновик» rule, plus the revision it was published as.
  check.expect(
    Boolean(draft?.content_hash) &&
      draft.content_hash === test.content_hash &&
      draft.content_hash === revision?.content_hash,
    'course draft hash differs from the live revision: unpublished course changes',
  );
  const hashesMatch = Boolean(live) && draftLocalization?.content_hash === live.content_hash;
  // Two different functions write the Russian hash: the live row always carries the COURSE hash
  // (the revision trigger inserts it first), while a Russian draft saved through
  // save_course_localization_draft carries the LOCALIZED hash. Same content, unequal hashes —
  // so there the fields themselves are compared, which is the stronger statement anyway.
  const fieldsMatch =
    Boolean(live && draftLocalization) &&
    ['title', 'description'].every((field) => live[field] === draftLocalization[field]) &&
    ['content', 'seo', 'sources'].every((field) => sameJson(live[field], draftLocalization[field]));
  check.facts.draftEqualsLive = hashesMatch
    ? 'content hash'
    : fieldsMatch
      ? 'fields (hash domains differ)'
      : 'no';
  check.expect(
    hashesMatch || (locale === 'ru' && fieldsMatch),
    'draft localization differs from the live one: unpublished changes',
  );
  check.expect(
    Boolean(mappings.live) && mappings.live.presentation_id === mappings.draft?.presentation_id,
    'draft and live presentation mappings differ',
  );
  // This list feeds the sitemap and the hreflang cluster of every language.
  check.expect(
    listed?.title === deck.title,
    `the public ${locale} catalogue does not list the course under the deck title`,
  );
}

export function checkTextAndSeo({
  check,
  live,
  publicRecord,
  deck,
  locale,
  russianLive,
  revisionId,
}) {
  check.expect(
    live?.title === deck.title,
    `title ${clip(live?.title ?? '')} differs from deck ${clip(deck.title)}`,
  );
  check.expect(live?.description === deck.description, 'description differs from the deck');
  const seo = live?.seo ?? {};
  for (const field of SEO_FIELDS) {
    check.expect(
      seo[field] === deck.seo[field],
      `seo.${field} ${clip(seo[field] ?? '')} differs from the deck`,
    );
  }
  check.expect(
    sameJson(Object.keys(seo).sort(), [...SEO_FIELDS].sort()),
    `seo carries unexpected fields: ${Object.keys(seo).join(',')}`,
  );
  // A block that fails this schema is dropped by the public page, which then renders the
  // Russian defaults on every language.
  check.expect(
    contentSeoSchema.safeParse(seo).success,
    'seo fails contentSeoSchema: the page would use defaults',
  );
  check.expect(
    sameJson(
      publishedSources(deck),
      (live?.sources ?? []).map(({ title, url }) => `${title}\n${url}`).sort(),
    ),
    'sources differ from the deck',
  );
  if (locale !== 'ru') {
    for (const field of SEO_TEXT_FIELDS) {
      const text = String(seo[field] ?? '');
      check.expect(
        !text.toLowerCase().includes(RUSSIAN_DEFAULT_MARKER) &&
          text !== RUSSIAN_DEFAULT_SEO.title &&
          text !== RUSSIAN_DEFAULT_SEO.description,
        `seo.${field} is the Russian default text`,
      );
      check.expect(text !== russianLive?.seo?.[field], `seo.${field} equals the Russian version`);
    }
  }
  check.expect(
    publicRecord?.locale === locale &&
      publicRecord.revisionId === revisionId &&
      publicRecord.title === deck.title &&
      publicRecord.description === deck.description &&
      sameJson(publicRecord.seo, deck.seo),
    'get_published_course_locale (anonymous read) does not return the deck text and SEO',
  );
}

async function checkPresentation({
  check,
  service,
  test,
  revision,
  mapping,
  presentation,
  publicRecord,
  disk,
  locale,
}) {
  check.expect(
    disk.pdfPageCount === disk.deck.slides.length,
    'presentation.pdf page count differs from the deck slides',
  );
  if (!check.expect(Boolean(mapping), 'no test_revision_presentations row')) return;
  if (!check.expect(Boolean(presentation), 'the mapped course_presentations row is missing'))
    return;
  check.facts.pages = Number(presentation.page_count);
  check.expect(presentation.status === 'ready', `status is ${clip(presentation.status)}`);
  check.expect(
    presentation.locale === locale,
    `presentation locale is ${clip(presentation.locale)}`,
  );
  check.expect(presentation.course_id === test.id, 'presentation belongs to another course');
  check.expect(
    presentation.storage_bucket === PRESENTATION_BUCKET,
    `bucket is ${clip(presentation.storage_bucket)}`,
  );
  check.expect(
    presentation.mime_type === 'application/pdf',
    `mime type is ${clip(presentation.mime_type)}`,
  );
  check.expect(
    Number(presentation.page_count) === disk.deck.slides.length,
    `page_count ${presentation.page_count} differs from ${disk.deck.slides.length} deck slides`,
  );
  check.expect(
    presentation.sha256 === disk.pdfSha256,
    'sha256 differs from presentation.pdf on disk',
  );
  check.expect(
    Number(presentation.byte_size) === disk.pdfByteSize,
    'byte_size differs from presentation.pdf on disk',
  );
  check.expect(
    presentation.storage_path ===
      `${test.id}/${locale}/${presentation.id}/${presentation.sha256}.pdf`,
    'storage path is not the content-addressed one',
  );
  // The Russian catalogue read still joins through the revision's own presentation column.
  if (locale === 'ru') {
    check.expect(
      revision?.presentation_id === presentation.id,
      'test_revisions.presentation_id is not the Russian mapping',
    );
  }
  const stored = await download(service, presentation.storage_path);
  if (check.expect(Boolean(stored), 'the stored PDF cannot be downloaded')) {
    check.expect(
      sha256(stored) === disk.pdfSha256,
      'the stored PDF differs from presentation.pdf on disk',
    );
  }
  check.expect(
    publicRecord?.presentation?.id === presentation.id &&
      Number(publicRecord.presentation.pageCount) === disk.deck.slides.length &&
      publicRecord.presentation.sha256 === disk.pdfSha256,
    'get_published_course_locale (anonymous read) points to another presentation',
  );
}

async function checkCover({ check, service, live, presentation, disk, slug }) {
  const ogImage = live?.seo?.ogImage;
  // Bundled covers only: a managed asset would already have failed the comparison with the deck.
  const bundled = typeof ogImage === 'string' && /^\/images\/[a-zA-Z0-9/_-]+\.webp$/u.test(ogImage);
  if (
    check.expect(bundled, `og image ${clip(ogImage ?? '')} is not a bundled /images/*.webp file`)
  ) {
    check.facts.cover = ogImage;
    // The catalogue card and the Course JSON-LD use this, not the raw SEO field.
    check.expect(
      getCourseCoverImage(slug, ogImage) === ogImage,
      'a bundled launch cover overrides the og image',
    );
    const bytes = await readFile(path.join(REPOSITORY_ROOT, 'public', ogImage)).catch(() => null);
    if (check.expect(Boolean(bytes), `public${ogImage} does not exist`)) {
      check.expect(isWebp(bytes), `public${ogImage} is not a WebP file`);
      check.expect(
        sha256(bytes) === disk.thumbnailSha256,
        `public${ogImage} differs from the reviewed thumbnail.webp`,
      );
    }
  }
  if (
    !check.expect(Boolean(presentation?.thumbnail_path), 'the presentation has no stored thumbnail')
  )
    return;
  const thumbnail = await download(service, presentation.thumbnail_path);
  if (check.expect(Boolean(thumbnail), 'the stored presentation thumbnail cannot be downloaded')) {
    check.expect(isWebp(thumbnail), 'the stored presentation thumbnail is not a WebP file');
  }
}

export function checkQuestions({
  check,
  revision,
  variants,
  variantLocalizations,
  assessment,
  locale,
}) {
  const policy = assessment.policy ?? {};
  check.expect(
    revision?.duration_minutes === policy.durationMinutes &&
      revision?.pass_score === policy.passScore &&
      revision?.question_count === policy.questionCount &&
      revision?.attempts_per_calendar_day === policy.attemptsPerCalendarDay &&
      revision?.attempt_reset_timezone === policy.resetTimezone,
    'the revision policy differs from assessment.json',
  );
  check.expect(variants.length === 3, `${variants.length} variants instead of 3`);
  check.expect(assessment.variants?.length === 3, 'assessment.json does not hold 3 variants');
  let questionTotal = 0;
  for (const authored of assessment.variants ?? []) {
    const label = `variant ${authored.variantNumber}`;
    const variant = variants.find((row) => row.variant_number === authored.variantNumber);
    if (!check.expect(Boolean(variant), `${label}: no test_revision_variants row`)) continue;
    check.expect(
      variant.stable_id === authored.id,
      `${label}: stable id differs from assessment.json`,
    );
    const row = variantLocalizations.find(
      (candidate) => candidate.variant_id === variant.id && candidate.locale === locale,
    );
    if (!check.expect(Boolean(row), `${label}: no ${locale} localization`)) continue;
    const stored = comparableQuestions(row.questions);
    const expected = comparableQuestions(authored.questions);
    questionTotal += stored.length;
    check.expect(
      stored.length === 10 && row.question_count === 10,
      `${label}: ${stored.length} questions instead of 10`,
    );
    check.expect(
      stored.every((question) => question.options.length === 4),
      `${label}: a question does not have 4 options`,
    );
    stored.forEach((question, index) => {
      const authoredQuestion = expected[index];
      const at = `${label} question ${index + 1}`;
      if (
        !check.expect(
          question.id === authoredQuestion?.id,
          `${at}: id differs from assessment.json`,
        )
      )
        return;
      check.expect(
        question.text === authoredQuestion.text,
        `${at}: text ${clip(question.text)} differs from the file`,
      );
      question.options.forEach((option, optionIndex) => {
        const authoredOption = authoredQuestion.options[optionIndex];
        check.expect(
          option.id === authoredOption?.id && option.text === authoredOption?.text,
          `${at} option ${optionIndex + 1}: ${clip(option.text)} differs from the file`,
        );
      });
    });
    const explanations = Array.isArray(row.explanations) ? row.explanations : [];
    check.expect(
      explanations.length === 10 &&
        explanations.every((text) => typeof text === 'string' && text.trim().length > 0),
      `${label}: not 10 non-empty explanations`,
    );
    check.expect(
      sameJson(
        explanations,
        authored.questions.map((question) => question.explanation),
      ),
      `${label}: explanations differ from assessment.json`,
    );
    // One structure per variant in every language, or an answer key would not fit a translation.
    const structureHashes = new Set(
      variantLocalizations
        .filter((candidate) => candidate.variant_id === variant.id)
        .map((candidate) => candidate.structure_hash),
    );
    check.expect(structureHashes.size === 1, `${label}: structure_hash differs between languages`);
  }
  check.facts.questions = questionTotal;
}

export function collectStrings({ live, variants, variantLocalizations, deck, locale }) {
  const strings = new Map();
  const add = (at, value) => {
    if (typeof value === 'string' && value.trim()) strings.set(at, value);
  };
  add('db.title', live?.title);
  add('db.description', live?.description);
  for (const field of SEO_TEXT_FIELDS) add(`db.seo.${field}`, live?.seo?.[field]);
  for (const variant of variants) {
    const row = variantLocalizations.find(
      (candidate) => candidate.variant_id === variant.id && candidate.locale === locale,
    );
    const at = `db.variant${variant.variant_number}`;
    comparableQuestions(row?.questions).forEach((question, index) => {
      add(`${at}.question${index + 1}`, question.text);
      question.options.forEach((option, optionIndex) =>
        add(`${at}.question${index + 1}.option${optionIndex + 1}`, option.text),
      );
    });
    (Array.isArray(row?.explanations) ? row.explanations : []).forEach((text, index) =>
      add(`${at}.explanation${index + 1}`, text),
    );
  }
  // The PDF was rendered from these strings, so a Russian slide is a Russian page of the deck.
  (deck.slides ?? []).forEach((slide, index) => {
    add(`deck.slide${index + 1}.title`, slide.title);
    add(`deck.slide${index + 1}.callout`, slide.callout);
    (slide.body ?? []).forEach((text, line) => add(`deck.slide${index + 1}.body${line + 1}`, text));
  });
  return strings;
}

async function runSqlChecks(disk) {
  // The private schema is closed to every API role, service_role included, so the only way to
  // count the keys is the database owner — inside a session that cannot write.
  const sql = `
    with batch as (
      select test.slug, test.current_revision_id
      from public.tests test
      where test.slug = any (array[${VERIFIED_SLUGS.map((slug) => `'${slug}'`).join(',')}])
    ), keyed as (
      select batch.slug, variant.variant_number,
        answer_key.variant_id is not null as has_key,
        coalesce(jsonb_array_length(answer_key.correct_option_ids), 0) as key_count,
        coalesce(jsonb_array_length(answer_key.explanations), 0) as explanation_count,
        (select count(*) from jsonb_array_elements(variant.questions) with ordinality question(value, position)
          where not exists (
            select 1 from jsonb_array_elements(question.value -> 'options') option(value)
            where option.value ->> 'id' = answer_key.correct_option_ids ->> (question.position::integer - 1)
          )) as dangling_keys,
        encode(extensions.digest(convert_to(coalesce((
          select string_agg(entry.value, ',' order by entry.position)
          from jsonb_array_elements_text(answer_key.correct_option_ids) with ordinality entry(value, position)
        ), ''), 'UTF8'), 'sha256'), 'hex') as key_digest
      from batch
      join public.test_revision_variants variant on variant.revision_id = batch.current_revision_id
      left join private.test_revision_variant_answer_keys answer_key
        on answer_key.revision_id = variant.revision_id and answer_key.variant_id = variant.id
    )
    select jsonb_build_object(
      'variants', (select coalesce(jsonb_agg(to_jsonb(keyed) order by slug, variant_number), '[]'::jsonb) from keyed),
      'openToApiRoles', (
        select coalesce(jsonb_agg(role.name || ':' || relation.name), '[]'::jsonb)
        from unnest(array['anon', 'authenticated']) role(name)
        cross join unnest(array[
          'private.test_revision_variant_answer_keys', 'public.course_drafts',
          'public.course_draft_localizations', 'public.test_revision_variants',
          'public.test_revision_variant_localizations'
        ]) relation(name)
        where has_table_privilege(role.name, relation.name, 'select')
          or has_any_column_privilege(role.name, relation.name, 'select')
      ),
      'revisionQuestionsOpenToAnon', has_column_privilege('anon', 'public.test_revisions', 'questions', 'select')
    )::text`;
  const { stdout } = await promisify(execFile)(
    'docker',
    [
      'exec',
      '-e',
      'PGOPTIONS=-c default_transaction_read_only=on',
      LOCAL_DATABASE_CONTAINER,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout.trim());
  const courses = {};
  for (const slug of VERIFIED_SLUGS) {
    const check = createCheck();
    const rows = result.variants.filter((row) => row.slug === slug);
    const authored = disk.get(`${slug}:ru`).assessment.variants;
    check.expect(rows.length === 3, `${rows.length} variants instead of 3`);
    check.expect(
      rows.every((row) => row.has_key),
      'a variant has no private answer-key row',
    );
    check.expect(
      rows.every((row) => row.key_count === 10),
      'a variant does not hold 10 keys',
    );
    check.expect(
      rows.every((row) => row.explanation_count === 10),
      'a variant does not hold 10 key explanations',
    );
    check.expect(
      rows.every((row) => row.dangling_keys === 0),
      'a key names an option its question does not have',
    );
    // Compared in memory only. The digest is never printed or written: with four public options
    // per question it could be brute-forced back into the key.
    check.expect(
      rows.every(
        (row) =>
          row.key_digest ===
          sha256(
            (
              authored.find((variant) => variant.variantNumber === row.variant_number)?.questions ??
              []
            )
              .map((question) => question.correctOptionId)
              .join(','),
          ),
      ),
      'the private keys differ from the reviewed assessment.json',
    );
    courses[slug] = {
      ok: check.problems.length === 0,
      problems: check.problems,
      keyRows: rows.filter((row) => row.has_key).length,
      keys: rows.reduce((total, row) => total + row.key_count, 0),
    };
  }
  const access = createCheck();
  access.expect(
    result.openToApiRoles.length === 0,
    `readable by an API role: ${result.openToApiRoles.join(', ')}`,
  );
  access.expect(
    result.revisionQuestionsOpenToAnon === false,
    'anon can select test_revisions.questions',
  );
  return { courses, access: { ok: access.problems.length === 0, problems: access.problems } };
}

function printTable(rows) {
  const header = ['course', 'lang', ...CHECK_IDS, 'warn'];
  const lines = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...lines.map((line) => String(line[column]).length)),
  );
  for (const [index, line] of lines.entries()) {
    console.log(line.map((cell, column) => String(cell).padEnd(widths[column])).join('  '));
    if (index === 0) console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  }
}

export async function verifyCourseBatch({
  environment = process.env,
  sql = false,
  strict = false,
  // Overridden only to prove the checks bite: a tampered copy of the files must fail.
  contentRoot = CONTENT_ROOT,
} = {}) {
  const url = assertLocalSupabaseUrl(environment.NEXT_PUBLIC_SUPABASE_URL);
  const secret = environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  const publishable = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!secret || !publishable) throw new Error('LOCAL_SUPABASE_KEYS_REQUIRED');
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createReadOnlyFetch(url.origin) },
  };
  const service = createClient(url.origin, secret, options);
  const anonymous = createClient(url.origin, publishable, options);

  const review = JSON.parse(await readFile(path.join(contentRoot, 'release-review.json'), 'utf8'));
  const disk = new Map();
  for (const slug of VERIFIED_SLUGS) {
    for (const locale of VERIFIED_LOCALES) {
      disk.set(`${slug}:${locale}`, await loadDiskEntry(contentRoot, slug, locale, review));
    }
  }
  const state = await readState(service);
  const catalogues = new Map();
  for (const locale of VERIFIED_LOCALES) {
    const list = await readPublic(anonymous, 'list_published_courses_locale', { p_locale: locale });
    catalogues.set(locale, Array.isArray(list?.items) ? list.items : []);
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: url.host,
    mode: { sql, strict },
    status: 'passed',
    courses: {},
  };
  const tableRows = [];
  let failed = 0;
  let warned = 0;

  for (const slug of VERIFIED_SLUGS) {
    const test = state.tests.find((row) => row.slug === slug);
    if (!test) {
      report.courses[slug] = { missing: true };
      tableRows.push([slug, '-', ...CHECK_IDS.map(() => 'FAIL'), 'course not found']);
      failed += CHECK_IDS.length;
      continue;
    }
    const revision = state.revisions.find((row) => row.id === test.current_revision_id);
    const draft = state.drafts.find((row) => row.test_id === test.id);
    const variants = state.variants
      .filter((row) => row.revision_id === test.current_revision_id)
      .sort((left, right) => left.variant_number - right.variant_number);
    const variantLocalizations = state.variantLocalizations.filter(
      (row) => row.revision_id === test.current_revision_id,
    );
    const liveOf = (locale) =>
      state.liveLocalizations.find(
        (row) => row.revision_id === test.current_revision_id && row.locale === locale,
      );
    const russianStrings = collectStrings({
      live: liveOf('ru'),
      variants,
      variantLocalizations,
      deck: disk.get(`${slug}:ru`).deck,
      locale: 'ru',
    });
    const course = {
      id: test.id,
      revisionId: test.current_revision_id,
      contentVersion: test.content_version,
      locales: {},
    };
    report.courses[slug] = course;

    for (const locale of VERIFIED_LOCALES) {
      const entry = disk.get(`${slug}:${locale}`);
      const live = liveOf(locale);
      const draftLocalization = state.draftLocalizations.find(
        (row) => row.test_id === test.id && row.locale === locale,
      );
      const mapping = state.liveMappings.find(
        (row) => row.revision_id === test.current_revision_id && row.locale === locale,
      );
      const presentation = state.presentations.find((row) => row.id === mapping?.presentation_id);
      const publicRecord = await readPublic(anonymous, 'get_published_course_locale', {
        p_slug: slug,
        p_locale: locale,
      });
      const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, createCheck()]));
      const warnings = [];

      checks.publication.expect(
        entry.reviewed,
        'the files on disk are not the ones in release-review.json',
      );
      checkPublication({
        check: checks.publication,
        test,
        draft,
        revision,
        live,
        draftLocalization,
        mappings: {
          live: mapping,
          draft: state.draftMappings.find(
            (row) => row.test_id === test.id && row.locale === locale,
          ),
        },
        listed: catalogues.get(locale).find((item) => item.slug === slug),
        deck: entry.deck,
        locale,
      });
      checkTextAndSeo({
        check: checks['text-seo'],
        live,
        publicRecord,
        deck: entry.deck,
        locale,
        russianLive: liveOf('ru'),
        revisionId: test.current_revision_id,
      });
      await checkPresentation({
        check: checks.presentation,
        service,
        test,
        revision,
        mapping,
        presentation,
        publicRecord,
        disk: entry,
        locale,
      });
      await checkCover({ check: checks.cover, service, live, presentation, disk: entry, slug });
      checkQuestions({
        check: checks.questions,
        revision,
        variants,
        variantLocalizations,
        assessment: entry.assessment,
        locale,
      });

      // `course_drafts.question_variants` is absent on purpose: it is the keyed source bank,
      // closed to every browser role. Everything a learner or the editor's browser can be
      // handed is scanned.
      const readable = {
        'anonymous get_published_course_locale': publicRecord,
        test_revision_localizations: live,
        course_draft_localizations: draftLocalization,
        test_revision_variant_localizations: variantLocalizations.filter(
          (row) => row.locale === locale,
        ),
        test_revision_variants: variants,
        test_revisions: revision,
      };
      for (const [source, value] of Object.entries(readable)) {
        for (const at of findAnswerKeyPaths(value ?? null, source)) {
          checks['no-answer-keys'].expect(false, `answer-key field at ${at}`);
        }
      }

      const strings = collectStrings({
        live,
        variants,
        variantLocalizations,
        deck: entry.deck,
        locale,
      });
      checks['no-russian-leftovers'].facts.strings = strings.size;
      for (const leftover of russianLeftovers(locale, strings, russianStrings)) {
        checks['no-russian-leftovers'].expect(false, leftover);
      }
      // Advisory, not a failure: the decks themselves cite the legal acts by their Russian
      // titles in all four languages, so the database matches the reviewed files. Whether a
      // Chinese reader should see «Закон РК …» in the sources card is an editorial decision.
      const russianTitles =
        locale === 'ru'
          ? []
          : (live?.sources ?? []).filter((source) =>
              locale === 'kk'
                ? liveOf('ru')?.sources?.some((russian) => russian.title === source.title)
                : cyrillicShare(source.title) > CYRILLIC_SHARE_LIMIT,
            );
      if (russianTitles.length > 0) {
        warnings.push(
          `${russianTitles.length} source titles are shown in Russian on the ${locale} page`,
        );
      }

      const failedHere = CHECK_IDS.filter((id) => checks[id].problems.length > 0);
      failed += failedHere.length;
      warned += warnings.length;
      course.locales[locale] = {
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            {
              ok: checks[id].problems.length === 0,
              problems: checks[id].problems,
              ...checks[id].facts,
            },
          ]),
        ),
        warnings,
      };
      tableRows.push([
        slug,
        locale,
        ...CHECK_IDS.map((id) => (checks[id].problems.length === 0 ? 'ok' : 'FAIL')),
        warnings.length > 0 ? String(warnings.length) : '-',
      ]);
    }
  }

  let total = tableRows.length * CHECK_IDS.length;
  if (sql) {
    try {
      report.sql = await runSqlChecks(disk);
    } catch (error) {
      // Asked for and not delivered is a failure, not a skipped step.
      report.sql = { unavailable: String(error?.code ?? error?.message ?? error).slice(0, 200) };
    }
    const sqlResults = report.sql.unavailable
      ? [{ ok: false }]
      : [...Object.values(report.sql.courses), report.sql.access];
    total += sqlResults.length;
    failed += sqlResults.filter((result) => !result.ok).length;
  }

  report.summary = { checks: total, failed, warnings: warned };
  report.status = failed > 0 || (strict && warned > 0) ? 'failed' : 'passed';
  return { report, tableRows };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const argv = process.argv.slice(2);
    if (!argv.every((argument) => argument === '--sql' || argument === '--strict')) {
      throw new Error('UNKNOWN_ARGUMENT (use --sql and/or --strict)');
    }
    const { report, tableRows } = await verifyCourseBatch({
      sql: argv.includes('--sql'),
      strict: argv.includes('--strict'),
    });
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);

    printTable(tableRows);
    for (const [slug, course] of Object.entries(report.courses)) {
      for (const [locale, result] of Object.entries(course.locales ?? {})) {
        for (const [id, check] of Object.entries(result.checks)) {
          for (const problem of check.problems)
            console.log(`FAIL ${slug}/${locale} ${id}: ${problem}`);
        }
        for (const warning of result.warnings) console.log(`warn ${slug}/${locale}: ${warning}`);
      }
    }
    if (report.sql?.unavailable) console.log(`FAIL sql: ${report.sql.unavailable}`);
    for (const [slug, result] of Object.entries(report.sql?.courses ?? {})) {
      console.log(
        `sql  ${slug}: ${result.ok ? 'ok' : 'FAIL'} — ${result.keyRows} private key rows, ${result.keys} keys${result.problems.map((problem) => `; ${problem}`).join('')}`,
      );
    }
    if (report.sql?.access) {
      console.log(
        `sql  key tables closed to anon/authenticated: ${report.sql.access.ok ? 'ok' : `FAIL — ${report.sql.access.problems.join('; ')}`}`,
      );
    }
    const warnings = `${report.summary.warnings} warnings${report.mode.strict ? ' (failures under --strict)' : ''}`;
    console.log(
      `${report.status.toUpperCase()} on ${report.target}: ${report.summary.checks - report.summary.failed}/${report.summary.checks} checks, ${warnings} → ${path.relative(REPOSITORY_ROOT, OUTPUT_PATH)}`,
    );
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    // Only the code-like message: a connection error must not echo a URL with a key in it.
    console.error(`REFUSED: ${String(error?.message ?? error).slice(0, 300)}`);
    process.exitCode = 1;
  }
}
