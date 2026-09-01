import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { validateAndRenderPresentation } from './course-content/presentation-pdf-qa.mjs';
import {
  buildLocalizedPublishedSnapshot,
  validateLocalizedPublishedSnapshot,
} from './content-localization/localized-published-snapshot.mjs';
import {
  assertLegacyRuContentContract,
  classifyLocalizedSchema,
} from './content-localization/linked-preflight-contract.mjs';
import { loadStage6PublicationBatch } from './content-localization/stage6-publication-contract.mjs';
import {
  clearLinkedPostgresConnection,
  linkedPostgresClientOptions,
  loadPostgresSslRootCertificate,
  parseLinkedPostgresConnection,
  redactLinkedPostgresError,
} from './database-backup-security.mjs';
import {
  assertCurrentProductionProjectRef,
  assertLinkedProductionProjectRef,
} from './production-operator-safety.mjs';

const { Client } = pg;
const ROOT = process.cwd();
const COURSE_ROOT = path.join(ROOT, 'content', 'snapshots', 'courses');
const ARTICLE_ROOT = path.join(ROOT, 'content', 'articles');
const MEDIA_ROOT = path.join(ROOT, 'content', 'snapshots', 'media');
const LOCALIZATION_ROOT = path.join(ROOT, 'content', 'snapshots', 'localizations');
const SEED_PATH = path.join(ROOT, 'supabase', 'seed.sql');
const checkOnly = process.argv.includes('--check');
const pull = process.argv.includes('--pull');
const visualQaApproved = process.argv.includes('--visual-qa-approved');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const expectedProjectRefArgument = argument('--expected-project-ref');
const sslRootCertificateArgument = argument('--ssl-root-cert');
const sslRootCertificateSha256Argument = argument('--ssl-root-cert-sha256');

if (!checkOnly && !pull) {
  console.error(
    'Usage: content-sync-linked.mjs (--pull [--visual-qa-approved] | --check) --expected-project-ref <current-production-ref> --ssl-root-cert <absolute-Supabase-CA.pem> [--ssl-root-cert-sha256 <lowercase-sha256>]',
  );
  process.exit(1);
}
if (checkOnly && visualQaApproved) {
  throw new Error('--visual-qa-approved is only valid with --pull.');
}
if (!expectedProjectRefArgument || !sslRootCertificateArgument) {
  throw new Error('Explicit linked project ref and PostgreSQL SSL root certificate are required.');
}
const expectedProjectRef = assertCurrentProductionProjectRef(expectedProjectRefArgument);
await assertLinkedProductionProjectRef(expectedProjectRef);
const sslRootCertificate = await loadPostgresSslRootCertificate(sslRootCertificateArgument, {
  expectedSha256: sslRootCertificateSha256Argument,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function generateSeed({ articlesRoot, coursesRoot, mediaRoot, localizationsRoot, outputPath }) {
  const script = path.join(ROOT, 'scripts', 'generate-content-seed.mjs');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--articles-root',
      articlesRoot,
      '--courses-root',
      coursesRoot,
      '--media-root',
      mediaRoot,
      '--localizations-root',
      localizationsRoot,
      '--output',
      outputPath,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim();
    throw new Error(
      `The deterministic content seed could not be staged.${detail ? ` ${detail}` : ''}`,
    );
  }
}

async function validateStagedSnapshot({ articlesRoot, coursesRoot, mediaRoot, localizationsRoot }) {
  const script = path.join(ROOT, 'scripts', 'course-content', 'validate-snapshot.mjs');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--articles-root',
      articlesRoot,
      '--snapshot-root',
      coursesRoot,
      '--media-root',
      mediaRoot,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? result.stdout ?? ''}`.trim();
    throw new Error(`The staged snapshot failed validation.${detail ? ` ${detail}` : ''}`);
  }
  await validateLocalizedPublishedSnapshot({
    root: ROOT,
    snapshotRoot: localizationsRoot,
    required: true,
  });
}

function reusablePresentationManifest(manifest, row, thumbnailSha256) {
  const pageCount = Number(row.page_count);
  return Boolean(
    manifest &&
    manifest.sha256 === row.sha256 &&
    manifest.thumbnailSha256 === thumbnailSha256 &&
    manifest.byteSize === Number(row.byte_size) &&
    manifest.pageCount === pageCount &&
    manifest.renderedPageCount === pageCount &&
    Array.isArray(manifest.pages) &&
    manifest.pages.length === pageCount &&
    manifest.validation?.automated?.status === 'passed' &&
    manifest.validation?.safety?.status === 'passed' &&
    manifest.validation?.visual?.status === 'passed' &&
    manifest.validation?.visual?.reviewedPageCount === pageCount,
  );
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

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function referencedContentAssetIds(value) {
  const ids = new Set();
  const source = JSON.stringify(value);
  for (const match of source.matchAll(
    /\/api\/content-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/giu,
  )) {
    ids.add(match[1].toLowerCase());
  }
  return ids;
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function linkedConnection() {
  await assertLinkedProductionProjectRef(expectedProjectRef);
  const cli = path.resolve('node_modules', 'supabase', 'dist', 'supabase.js');
  const result = spawnSync(process.execPath, [cli, 'db', 'dump', '--linked', '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Supabase CLI could not create a temporary linked database login.');
  }
  const connection = parseLinkedPostgresConnection(`${result.stdout}\n${result.stderr}`);
  if (!connection) {
    throw new Error('Temporary linked database credentials were not available.');
  }
  await assertLinkedProductionProjectRef(expectedProjectRef);
  return connection;
}

function asDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function asTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function linkedStorageAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/u, '');
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error('Linked Supabase Storage credentials are required for content parity.');
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname !== `${expectedProjectRef}.supabase.co`
  ) {
    throw new Error('Refusing an unexpected linked Storage host.');
  }
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function downloadPublishedContentAsset(storage, storageKey) {
  const { data, error } = await storage.storage.from('content-media').download(storageKey);
  if (error || !data) {
    throw new Error(`Published article media is unavailable: ${storageKey}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

async function downloadPublishedPresentationAsset(storage, bucket, storagePath) {
  const { data, error } = await storage.storage.from(bucket).download(storagePath);
  if (error || !data) {
    throw new Error('Published presentation object is unavailable.');
  }
  return Buffer.from(await data.arrayBuffer());
}

const connection = await linkedConnection();
const client = new Client(
  linkedPostgresClientOptions(connection, {
    application_name: 'safetyhub-content-parity',
    statement_timeout: 2 * 60 * 1000,
    query_timeout: 2 * 60 * 1000,
    sslRootCertificate,
  }),
);
const storage = linkedStorageAdmin();

let courseRows;
let variantRows;
let articleRows;
let articleAssetRows;
let localizationSchemaMode;
let courseLocalizationRows;
let variantLocalizationRows;
let articleLocalizationRows;
let legalVersionRows;
let legalLocalizationRows;
try {
  await client.connect();
  await client.query('begin isolation level repeatable read read only');
  await client.query('set local role postgres');
  const localizationSchemaState = (
    await client.query(`
      select
        to_regtype('public.app_locale') is not null as "appLocale",
        to_regclass('public.legal_document_localizations') is not null
          as "legalDocumentLocalizations",
        to_regclass('public.test_revision_localizations') is not null
          as "testRevisionLocalizations",
        to_regclass('public.test_revision_presentations') is not null
          as "testRevisionPresentations",
        to_regclass('public.test_revision_variant_localizations') is not null
          as "testRevisionVariantLocalizations",
        to_regclass('public.article_revision_localizations') is not null
          as "articleRevisionLocalizations"
    `)
  ).rows[0];
  localizationSchemaMode = classifyLocalizedSchema(localizationSchemaState);
  if (localizationSchemaMode === 'legacy-ru' && !checkOnly) {
    throw new Error('LEGACY_RU_CONTENT_PULL_REQUIRES_CHECK_ONLY');
  }
  courseRows = (
    await client.query(`
      select
        test.id as course_id,
        revision.id as revision_id,
        revision.slug,
        revision.title,
        revision.description,
        revision.icon,
        revision.display_order,
        revision.duration_minutes,
        revision.pass_score,
        revision.question_count,
        revision.attempts_per_calendar_day,
        revision.attempt_reset_timezone,
        revision.seo,
        revision.jurisdiction,
        revision.effective_date,
        revision.sources,
        revision.content_hash,
        revision.published_at,
        presentation.id as presentation_id,
        presentation.storage_bucket,
        presentation.storage_path,
        presentation.thumbnail_path,
        presentation.source_filename,
        presentation.mime_type,
        presentation.byte_size,
        presentation.sha256,
        presentation.page_count,
        presentation.aspect_ratio
      from public.tests test
      join public.test_revisions revision on revision.id = test.current_revision_id
      join public.course_presentations presentation
        on presentation.id = revision.presentation_id
      where test.status = 'published' and presentation.status = 'ready'
      order by revision.display_order, revision.slug
    `)
  ).rows;
  variantRows = (
    await client.query(`
      select
        variant.id,
        variant.stable_id,
        variant.revision_id,
        variant.variant_number,
        variant.questions,
        answer_key.correct_option_ids,
        answer_key.explanations
      from public.test_revision_variants variant
      join private.test_revision_variant_answer_keys answer_key
        on answer_key.variant_id = variant.id
       and answer_key.revision_id = variant.revision_id
      join public.tests test on test.current_revision_id = variant.revision_id
      where test.status = 'published'
      order by variant.revision_id, variant.variant_number
    `)
  ).rows;
  articleRows = (
    await client.query(`
      select
        article.id,
        article.created_at,
        revision.slug,
        revision.title,
        revision.description,
        revision.cover_image,
        revision.blocks,
        revision.seo,
        revision.jurisdiction,
        revision.effective_date,
        revision.sources,
        revision.content_hash,
        revision.published_at
      from public.articles article
      join public.article_revisions revision on revision.id = article.current_revision_id
      where article.status = 'published' and article.is_published
      order by revision.slug
    `)
  ).rows;
  articleAssetRows = (
    await client.query(`
      with published_asset_ids as (
        select distinct (matches.captures)[1]::uuid as id
        from public.articles article
        join public.article_revisions revision on revision.id = article.current_revision_id
        cross join lateral regexp_matches(
          jsonb_build_object(
            'coverImage', revision.cover_image,
            'blocks', revision.blocks,
            'seo', revision.seo
          )::text,
          '/api/content-assets/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})',
          'g'
        ) as matches(captures)
        where article.status = 'published' and article.is_published
      )
      select distinct
        asset.id,
        asset.storage_key,
        asset.mime_type,
        asset.width,
        asset.height,
        asset.byte_size,
        asset.sha256
      from public.content_assets asset
      join published_asset_ids referenced on referenced.id = asset.id
      where asset.status = 'active'
      order by asset.storage_key
    `)
  ).rows;
  if (localizationSchemaMode === 'localized') {
    courseLocalizationRows = (
      await client.query(`
      select
        test.id as course_id,
        revision.id as revision_id,
        revision.slug,
        localization.locale::text as locale,
        localization.title,
        localization.description,
        localization.content,
        localization.seo,
        localization.sources,
        localization.content_hash as localization_content_hash,
        presentation.id as presentation_id,
        presentation.locale::text as presentation_locale,
        presentation.storage_bucket,
        presentation.storage_path,
        presentation.thumbnail_path,
        presentation.source_filename,
        presentation.mime_type,
        presentation.byte_size as presentation_byte_size,
        presentation.sha256 as presentation_sha256,
        presentation.page_count as presentation_page_count,
        presentation.aspect_ratio,
        presentation.status as presentation_status
      from public.tests test
      join public.test_revisions revision
        on revision.id = test.current_revision_id
      join public.test_revision_localizations localization
        on localization.revision_id = revision.id
      join public.test_revision_presentations mapping
        on mapping.revision_id = revision.id
       and mapping.locale = localization.locale
      join public.course_presentations presentation
        on presentation.id = mapping.presentation_id
      where test.status = 'published'
      order by
        revision.display_order,
        revision.slug,
        array_position(enum_range(null::public.app_locale), localization.locale)
      `)
    ).rows;
    variantLocalizationRows = (
      await client.query(`
      select
        revision.id as revision_id,
        revision.slug,
        variant.stable_id,
        variant.variant_number,
        localization.locale::text as locale,
        localization.questions,
        localization.explanations,
        localization.question_count,
        localization.structure_hash,
        localization.content_hash as variant_content_hash
      from public.tests test
      join public.test_revisions revision
        on revision.id = test.current_revision_id
      join public.test_revision_variants variant
        on variant.revision_id = revision.id
      join public.test_revision_variant_localizations localization
        on localization.revision_id = revision.id
       and localization.variant_id = variant.id
      where test.status = 'published'
      order by
        revision.display_order,
        revision.slug,
        variant.variant_number,
        array_position(enum_range(null::public.app_locale), localization.locale)
      `)
    ).rows;
    articleLocalizationRows = (
      await client.query(`
      select
        article.id as article_id,
        revision.id as revision_id,
        revision.slug,
        localization.locale::text as locale,
        localization.title,
        localization.description,
        localization.blocks,
        localization.seo,
        localization.sources,
        localization.content_hash as localization_content_hash
      from public.articles article
      join public.article_revisions revision
        on revision.id = article.current_revision_id
      join public.article_revision_localizations localization
        on localization.revision_id = revision.id
      where article.status = 'published' and article.is_published
      order by
        revision.slug,
        array_position(enum_range(null::public.app_locale), localization.locale)
      `)
    ).rows;
    legalVersionRows = (
      await client.query(`
      select
        legal.document_type::text as document_type,
        legal.version,
        legal.body_revision,
        legal.effective_at,
        legal.is_current
      from public.legal_document_versions legal
      order by legal.document_type, legal.version
      `)
    ).rows;
    legalLocalizationRows = (
      await client.query(`
      select
        localization.document_type::text as document_type,
        localization.version,
        localization.locale::text as locale,
        localization.title,
        localization.body,
        localization.body_hash,
        localization.status
      from public.legal_document_localizations localization
      order by
        localization.document_type,
        localization.version,
        array_position(enum_range(null::public.app_locale), localization.locale)
      `)
    ).rows;
  }
  await client.query('commit');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  throw new Error(`Linked content export failed: ${redactLinkedPostgresError(error, connection)}`);
} finally {
  clearLinkedPostgresConnection(connection);
  await client.end().catch(() => undefined);
}

if (courseRows.length === 0) {
  throw new Error('Hosted catalog has no published courses with ready presentations.');
}

const existingCatalog = await readJsonIfPresent(path.join(COURSE_ROOT, 'catalog.json'));
const existingCourses = new Map();
for (const item of existingCatalog?.courses ?? []) {
  const value = await readJsonIfPresent(path.join(COURSE_ROOT, item.slug, 'course.json'));
  if (value) existingCourses.set(item.slug, value);
}

const variantsByRevision = new Map();
for (const row of variantRows) {
  const questions = row.questions.map((question, questionIndex) => ({
    id: question.id,
    text: question.text,
    displayOrder: questionIndex + 1,
    options: question.options.map((option, optionIndex) => ({
      id: option.id,
      text: option.text,
      displayOrder: optionIndex + 1,
    })),
    correctOptionId: row.correct_option_ids[questionIndex],
    explanation: row.explanations[questionIndex] ?? '',
  }));
  const item = {
    id: row.stable_id,
    variantNumber: row.variant_number,
    questions,
  };
  const collection = variantsByRevision.get(row.revision_id) ?? [];
  collection.push(item);
  variantsByRevision.set(row.revision_id, collection);
}

const desiredFiles = new Map();
const hostedCourses = [];
const publishedPresentationAssets = new Map(
  await Promise.all(
    courseRows.map(async (row) => {
      if (
        row.storage_bucket !== 'course-presentations' ||
        row.mime_type !== 'application/pdf' ||
        row.aspect_ratio !== '16:9' ||
        typeof row.storage_path !== 'string' ||
        typeof row.thumbnail_path !== 'string'
      ) {
        throw new Error(`${row.slug}: published presentation metadata is invalid.`);
      }
      const [pdf, thumbnail] = await Promise.all([
        downloadPublishedPresentationAsset(storage, row.storage_bucket, row.storage_path),
        downloadPublishedPresentationAsset(storage, row.storage_bucket, row.thumbnail_path),
      ]);
      const pdfHash = sha256(pdf);
      if (pdfHash !== row.sha256 || pdf.length !== Number(row.byte_size)) {
        throw new Error(`${row.slug}: hosted PDF does not match database metadata.`);
      }
      return [row.revision_id, { pdf, thumbnail, thumbnailHash: sha256(thumbnail) }];
    }),
  ),
);
let localizedSnapshot = null;
if (localizationSchemaMode === 'localized') {
  const stage6Batch = await loadStage6PublicationBatch({ root: ROOT, validateRelease: true });
  const targetPresentationRows = courseLocalizationRows.filter((row) => row.locale !== 'ru');
  if (targetPresentationRows.length !== 15) {
    throw new Error(
      'Hosted localized catalog must expose exactly 15 target-locale presentation rows.',
    );
  }
  const localizedPresentationAssets = new Map(
    await Promise.all(
      targetPresentationRows.map(async (row) => {
        if (
          row.storage_bucket !== 'course-presentations' ||
          row.presentation_status !== 'ready' ||
          row.presentation_locale !== row.locale ||
          typeof row.storage_path !== 'string' ||
          typeof row.thumbnail_path !== 'string'
        ) {
          throw new Error('Hosted localized presentation metadata is invalid.');
        }
        const [pdf, thumbnail] = await Promise.all([
          downloadPublishedPresentationAsset(storage, row.storage_bucket, row.storage_path),
          downloadPublishedPresentationAsset(storage, row.storage_bucket, row.thumbnail_path),
        ]);
        return [row.presentation_id, { pdf, thumbnail }];
      }),
    ),
  );
  localizedSnapshot = buildLocalizedPublishedSnapshot({
    batch: stage6Batch,
    courseLocalizationRows,
    variantLocalizationRows,
    articleLocalizationRows,
    legalVersionRows,
    legalLocalizationRows,
    presentationAssets: localizedPresentationAssets,
  });
  for (const [relativePath, bytes] of localizedSnapshot.files) {
    desiredFiles.set(path.join(LOCALIZATION_ROOT, ...relativePath.split('/')), bytes);
  }
}
const qaRunId = sha256(
  Buffer.from(
    JSON.stringify(
      courseRows.map((row) => ({
        revisionId: row.revision_id,
        contentHash: row.content_hash,
        pdfSha256: row.sha256,
        thumbnailSha256: publishedPresentationAssets.get(row.revision_id).thumbnailHash,
      })),
    ),
    'utf8',
  ),
).slice(0, 24);
const qaRoot = path.join(ROOT, 'tmp', 'course-materials', 'linked-pdf-qa', qaRunId);
const qaRequiredSlugs = [];
const approvalMissingSlugs = [];
const reviewTimestamp = new Date().toISOString();
let latestPublishedAt = new Date(0);
for (const row of courseRows) {
  const existing = existingCourses.get(row.slug);
  const variants = variantsByRevision.get(row.revision_id) ?? [];
  const { pdf, thumbnail, thumbnailHash } = publishedPresentationAssets.get(row.revision_id);
  const publishedAt = new Date(row.published_at);
  if (publishedAt > latestPublishedAt) latestPublishedAt = publishedAt;
  const presentation = {
    id: row.presentation_id,
    sourceFilename: row.source_filename,
    ...(existing?.presentation?.operatorPptx
      ? { operatorPptx: existing.presentation.operatorPptx }
      : {}),
    file: 'presentation.pdf',
    thumbnail: 'thumbnail.webp',
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    thumbnailPath: row.thumbnail_path,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    pageCount: Number(row.page_count),
    aspectRatio: row.aspect_ratio,
    sha256: row.sha256,
    thumbnailSha256: thumbnailHash,
    notesIncluded: false,
  };
  const course = {
    schemaVersion: 1,
    id: row.course_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    icon: row.icon,
    displayOrder: row.display_order,
    updatedAt:
      existing?.dbContentHash === row.content_hash
        ? existing.updatedAt
        : asTimestamp(row.published_at),
    jurisdiction: row.jurisdiction ?? '',
    effectiveDate: asDate(row.effective_date),
    seo: row.seo ?? {},
    sources: row.sources ?? [],
    policy: {
      durationMinutes: row.duration_minutes,
      passScore: row.pass_score,
      questionCount: row.question_count,
      variantCount: variants.length,
      attemptsPerCalendarDay: row.attempts_per_calendar_day,
      resetTimezone: row.attempt_reset_timezone,
    },
    presentation,
    variants,
    ...(existing?.sourceMaterials ? { sourceMaterials: existing.sourceMaterials } : {}),
    dbContentHash: row.content_hash,
  };
  const computedDbHash = canonicalHash(databaseContentProjection(course));
  if (computedDbHash !== row.content_hash) {
    throw new Error(`${row.slug}: published revision cannot reproduce its content hash.`);
  }
  const snapshotProjection = structuredClone(course);
  course.snapshotContentHash = canonicalHash(snapshotProjection);
  course.contentHash = row.content_hash;
  hostedCourses.push(course);

  const courseDirectory = path.join(COURSE_ROOT, row.slug);
  const existingManifest = await readJsonIfPresent(
    path.join(courseDirectory, 'presentation-manifest.json'),
  );
  let manifest = existingManifest;
  if (!reusablePresentationManifest(existingManifest, row, thumbnailHash)) {
    qaRequiredSlugs.push(row.slug);
    const priorQaManifest = await readJsonIfPresent(
      path.join(qaRoot, row.slug, 'presentation-manifest.json'),
    );
    const priorQaMatches = Boolean(
      priorQaManifest &&
      priorQaManifest.sha256 === row.sha256 &&
      priorQaManifest.thumbnailSha256 === thumbnailHash &&
      priorQaManifest.pageCount === Number(row.page_count) &&
      priorQaManifest.renderedPageCount === Number(row.page_count) &&
      priorQaManifest.validation?.automated?.status === 'passed' &&
      priorQaManifest.validation?.safety?.status === 'passed' &&
      priorQaManifest.validation?.visual?.status === 'pending',
    );
    const approveThisPresentation = visualQaApproved && priorQaMatches;
    if (visualQaApproved && !priorQaMatches) approvalMissingSlugs.push(row.slug);
    const qa = await validateAndRenderPresentation({
      slug: row.slug,
      pdfBytes: pdf,
      thumbnailBytes: thumbnail,
      expectedByteSize: Number(row.byte_size),
      expectedPageCount: Number(row.page_count),
      expectedSha256: row.sha256,
      expectedThumbnailSha256: thumbnailHash,
      qaRoot,
      visualQaApproved: approveThisPresentation,
      reviewedAt: approveThisPresentation ? reviewTimestamp : null,
    });
    manifest = qa.manifest;
  }
  desiredFiles.set(path.join(courseDirectory, 'course.json'), Buffer.from(jsonText(course)));
  desiredFiles.set(path.join(courseDirectory, 'presentation.pdf'), pdf);
  desiredFiles.set(path.join(courseDirectory, 'thumbnail.webp'), thumbnail);
  desiredFiles.set(
    path.join(courseDirectory, 'presentation-manifest.json'),
    Buffer.from(jsonText(manifest)),
  );
}

const totals = {
  courseCount: hostedCourses.length,
  presentationCount: hostedCourses.length,
  presentationPageCount: hostedCourses.reduce(
    (sum, course) => sum + course.presentation.pageCount,
    0,
  ),
  variantCount: hostedCourses.reduce((sum, course) => sum + course.variants.length, 0),
  questionCount: hostedCourses.reduce(
    (sum, course) =>
      sum + course.variants.reduce((inner, variant) => inner + variant.questions.length, 0),
    0,
  ),
  optionCount: hostedCourses.reduce(
    (sum, course) =>
      sum +
      course.variants.reduce(
        (variantSum, variant) =>
          variantSum +
          variant.questions.reduce(
            (questionSum, question) => questionSum + question.options.length,
            0,
          ),
        0,
      ),
    0,
  ),
  correctAnswerCount: hostedCourses.reduce(
    (sum, course) =>
      sum + course.variants.reduce((inner, variant) => inner + variant.questions.length, 0),
    0,
  ),
};
const catalogChecksum = sha256(
  Buffer.from(hostedCourses.map((course) => course.dbContentHash).join(','), 'utf8'),
);
const sameCatalog = existingCatalog?.catalogChecksum === catalogChecksum;
const optionLetters = ['А', 'Б', 'В', 'Г'];
const answerKeyMatrix = Object.fromEntries(
  hostedCourses.map((course) => [
    course.slug,
    course.variants.map((variant) =>
      variant.questions.map((question) => {
        const optionIndex = question.options.findIndex(
          (option) => option.id === question.correctOptionId,
        );
        if (optionIndex < 0 || optionIndex >= optionLetters.length) {
          throw new Error(
            `${course.slug}: correct option is not part of the published question.`,
          );
        }
        return optionLetters[optionIndex];
      }),
    ),
  ]),
);
const catalog = {
  schemaVersion: 1,
  catalogVersion: sameCatalog
    ? existingCatalog.catalogVersion
    : `hosted-${catalogChecksum.slice(0, 16)}`,
  updatedAt: sameCatalog ? existingCatalog.updatedAt : latestPublishedAt.toISOString(),
  ...(existingCatalog?.policy ? { policy: existingCatalog.policy } : {}),
  totals,
  courses: hostedCourses.map((course) => ({
    id: course.id,
    slug: course.slug,
    title: course.title,
    displayOrder: course.displayOrder,
    contentHash: course.contentHash,
    dbContentHash: course.dbContentHash,
    snapshotContentHash: course.snapshotContentHash,
    presentationSha256: course.presentation.sha256,
    pageCount: course.presentation.pageCount,
  })),
  ...(existingCatalog?.sourceDocument
    ? { sourceDocument: existingCatalog.sourceDocument }
    : {}),
  answerKeyMatrix,
  ...(existingCatalog?.approvedWordingCorrection
    ? { approvedWordingCorrection: existingCatalog.approvedWordingCorrection }
    : {}),
  catalogChecksum,
};
catalog.catalogHash = canonicalHash(catalog);
desiredFiles.set(path.join(COURSE_ROOT, 'catalog.json'), Buffer.from(jsonText(catalog)));

const hostedArticleDocuments = [];
for (const row of articleRows) {
  const filePath = path.join(ARTICLE_ROOT, `${row.slug}.json`);
  const existing = await readJsonIfPresent(filePath);
  const comparable = {
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverImage: row.cover_image,
    blocks: row.blocks,
    seo: row.seo ?? {},
    jurisdiction: row.jurisdiction ?? '',
    effectiveDate: asDate(row.effective_date),
    sources: row.sources ?? [],
  };
  const existingComparable = existing
    ? Object.fromEntries(Object.keys(comparable).map((key) => [key, existing[key]]))
    : null;
  const unchanged =
    existingComparable && canonicalHash(existingComparable) === canonicalHash(comparable);
  const article = {
    ...comparable,
    createdAt: unchanged ? existing.createdAt : asTimestamp(row.created_at),
    updatedAt: unchanged ? existing.updatedAt : asTimestamp(row.published_at),
  };
  hostedArticleDocuments.push(article);
  desiredFiles.set(filePath, Buffer.from(jsonText(article)));
}

const referencedAssetIds = new Set(
  hostedArticleDocuments.flatMap((article) => [...referencedContentAssetIds(article)]),
);
const assetsById = new Map(articleAssetRows.map((asset) => [String(asset.id).toLowerCase(), asset]));
for (const assetId of referencedAssetIds) {
  if (!assetsById.has(assetId)) {
    throw new Error(`Published article references unavailable media ${assetId}.`);
  }
}

const mediaAssets = [];
if (referencedAssetIds.size > 0) {
  for (const assetId of [...referencedAssetIds].sort()) {
    const asset = assetsById.get(assetId);
    if (
      !asset ||
      asset.mime_type !== 'image/webp' ||
      !/^[0-9a-f]{2}\/[0-9a-f]{64}[.]webp$/u.test(asset.storage_key) ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
      Number(asset.byte_size) < 1 ||
      Number(asset.byte_size) > 2 * 1024 * 1024 ||
      Number(asset.width) < 1 ||
      Number(asset.width) > 1600 ||
      Number(asset.height) < 1 ||
      Number(asset.height) > 1600
    ) {
      throw new Error(`Published article media metadata is invalid: ${assetId}.`);
    }
    const bytes = await downloadPublishedContentAsset(storage, asset.storage_key);
    if (bytes.length !== Number(asset.byte_size) || sha256(bytes) !== asset.sha256) {
      throw new Error(`Published article media hash mismatch: ${assetId}.`);
    }
    const filename = `${asset.sha256}.webp`;
    mediaAssets.push({
      id: assetId,
      storageKey: asset.storage_key,
      file: filename,
      mimeType: 'image/webp',
      width: Number(asset.width),
      height: Number(asset.height),
      byteSize: Number(asset.byte_size),
      sha256: asset.sha256,
    });
    desiredFiles.set(path.join(MEDIA_ROOT, filename), bytes);
  }
}
const mediaManifestProjection = {
  schemaVersion: 1,
  bucket: 'content-media',
  assets: mediaAssets,
};
const mediaManifest = {
  ...mediaManifestProjection,
  manifestHash: canonicalHash(mediaManifestProjection),
};
desiredFiles.set(path.join(MEDIA_ROOT, 'manifest.json'), Buffer.from(jsonText(mediaManifest)));

const differences = [];
for (const [filePath, desired] of desiredFiles) {
  let current = null;
  try {
    current = await readFile(filePath);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  if (!current || !current.equals(desired)) {
    differences.push({
      path: path.relative(ROOT, filePath).replaceAll('\\', '/'),
      before: current ? sha256(current) : null,
      after: sha256(desired),
    });
  }
}

async function listFilesRecursively(directory) {
  const files = [];
  const visit = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error('Canonical snapshot contains an unsupported special file.');
    }
  };
  await visit(directory);
  return files;
}

const hostedSlugs = new Set(hostedCourses.map((course) => course.slug));
const staleCourseDirectories = (await readdir(COURSE_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !hostedSlugs.has(entry.name))
  .map((entry) => path.join(COURSE_ROOT, entry.name));
const hostedArticleSlugs = new Set(articleRows.map((article) => article.slug));
const staleArticleFiles = (await readdir(ARTICLE_ROOT))
  .filter((name) => name.endsWith('.json') && !hostedArticleSlugs.has(name.slice(0, -5)))
  .map((name) => path.join(ARTICLE_ROOT, name));
const desiredMediaFiles = new Set(
  mediaAssets.map((asset) => asset.file).concat('manifest.json'),
);
const staleMediaFiles = (await readdir(MEDIA_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && !desiredMediaFiles.has(entry.name))
  .map((entry) => path.join(MEDIA_ROOT, entry.name));
const desiredLocalizedFiles = new Set(
  localizedSnapshot
    ? [...localizedSnapshot.files.keys()].map((relativePath) =>
        path.join(LOCALIZATION_ROOT, ...relativePath.split('/')),
      )
    : [],
);
const staleLocalizedFiles = localizedSnapshot
  ? (await listFilesRecursively(LOCALIZATION_ROOT)).filter(
      (filePath) => !desiredLocalizedFiles.has(filePath),
    )
  : [];
const canonicalRoots = [COURSE_ROOT, ARTICLE_ROOT, MEDIA_ROOT];
const desiredCanonicalFiles = new Set(
  [...desiredFiles.keys()].filter((filePath) =>
    canonicalRoots.some((root) => {
      const relative = path.relative(root, filePath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    }),
  ),
);
const legacyUnexpectedCanonicalFiles =
  localizationSchemaMode === 'legacy-ru'
    ? (await Promise.all(canonicalRoots.map((root) => listFilesRecursively(root))))
        .flat()
        .filter((filePath) => !desiredCanonicalFiles.has(filePath))
    : [];
for (const stale of new Set([
  ...staleCourseDirectories,
  ...staleArticleFiles,
  ...staleMediaFiles,
  ...staleLocalizedFiles,
  ...legacyUnexpectedCanonicalFiles,
])) {
  differences.push({
    path: path.relative(ROOT, stale).replaceAll('\\', '/'),
    before: 'present',
    after: null,
  });
}

if (localizationSchemaMode === 'legacy-ru') {
  differences.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const legacyContract = assertLegacyRuContentContract({
    catalogChecksum,
    localCatalogChecksum: existingCatalog?.catalogChecksum,
    totals,
    articleCount: articleRows.length,
    courses: hostedCourses.map((course) => ({
      durationMinutes: course.policy.durationMinutes,
      passScore: course.policy.passScore,
      attemptsPerCalendarDay: course.policy.attemptsPerCalendarDay,
      resetTimezone: course.policy.resetTimezone,
      variants: course.variants.map((variant) =>
        variant.questions.map((question) => question.options.length),
      ),
    })),
  });
  console.log(
    JSON.stringify({
      ok: differences.length === 0,
      mode: 'legacy-preflight',
      schemaMode: localizationSchemaMode,
      catalogChecksum,
      totals: { ...totals, articleCount: articleRows.length },
      contract: legacyContract,
      verifiedRoots: ['content/snapshots/courses', 'content/articles', 'content/snapshots/media'],
      differences,
      presentationQa: {
        requiredCourses: qaRequiredSlugs,
        qaRoot: qaRequiredSlugs.length > 0 ? qaRoot : null,
      },
    }),
  );
  if (differences.length > 0) process.exitCode = 1;
} else {
const stageRoot = path.join(ROOT, 'tmp', 'content-sync-stage', randomUUID());
const stagedCourseRoot = path.join(stageRoot, 'courses');
const stagedArticleRoot = path.join(stageRoot, 'articles');
const stagedMediaRoot = path.join(stageRoot, 'media');
const stagedLocalizationRoot = path.join(stageRoot, 'localizations');
const stagedSeedPath = path.join(stageRoot, 'seed.sql');

function stagedPathFor(canonicalPath) {
  for (const [canonicalRoot, stagedRoot] of [
    [COURSE_ROOT, stagedCourseRoot],
    [ARTICLE_ROOT, stagedArticleRoot],
    [MEDIA_ROOT, stagedMediaRoot],
    [LOCALIZATION_ROOT, stagedLocalizationRoot],
  ]) {
    const relative = path.relative(canonicalRoot, canonicalPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return path.join(stagedRoot, relative);
    }
  }
  throw new Error(`Refusing to stage an unexpected content path: ${canonicalPath}`);
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EISDIR') return true;
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    try {
      await readdir(filePath);
      return true;
    } catch (directoryError) {
      if (
        directoryError &&
        typeof directoryError === 'object' &&
        directoryError.code === 'ENOENT'
      ) {
        return false;
      }
      throw directoryError;
    }
  }
}

async function replaceCanonicalSnapshot() {
  const backupRoot = path.join(stageRoot, 'rollback');
  const swaps = [
    { name: 'courses', current: COURSE_ROOT, staged: stagedCourseRoot },
    { name: 'articles', current: ARTICLE_ROOT, staged: stagedArticleRoot },
    { name: 'media', current: MEDIA_ROOT, staged: stagedMediaRoot },
    {
      name: 'localizations',
      current: LOCALIZATION_ROOT,
      staged: stagedLocalizationRoot,
    },
    { name: 'seed.sql', current: SEED_PATH, staged: stagedSeedPath },
  ].map((swap) => ({ ...swap, backup: path.join(backupRoot, swap.name) }));
  const movedCurrent = [];
  const installed = [];
  await mkdir(backupRoot, { recursive: true });
  try {
    for (const swap of swaps) {
      await mkdir(path.dirname(swap.current), { recursive: true });
      await mkdir(path.dirname(swap.backup), { recursive: true });
      if (await exists(swap.current)) {
        await rename(swap.current, swap.backup);
        movedCurrent.push(swap);
      }
      await rename(swap.staged, swap.current);
      installed.push(swap);
    }
  } catch (error) {
    for (const swap of [...swaps].reverse()) {
      if (installed.includes(swap)) {
        await rm(swap.current, { recursive: true, force: true }).catch(() => undefined);
      }
      if (movedCurrent.includes(swap) && (await exists(swap.backup))) {
        await rename(swap.backup, swap.current).catch(() => undefined);
      }
    }
    throw error;
  }
  await rm(backupRoot, { recursive: true, force: true });
}

async function assertCanonicalStateUnchanged() {
  for (const difference of differences) {
    const currentPath = path.resolve(ROOT, difference.path);
    const relative = path.relative(ROOT, currentPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to recheck an unsafe canonical content path.');
    }
    if (difference.before === null) {
      if (await exists(currentPath)) {
        throw new Error(`${difference.path} changed after the preview; rerun the pull.`);
      }
    } else if (difference.before === 'present') {
      if (!(await exists(currentPath))) {
        throw new Error(`${difference.path} changed after the preview; rerun the pull.`);
      }
    } else {
      const current = await readFile(currentPath).catch((error) => {
        if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
        throw error;
      });
      if (!current || sha256(current) !== difference.before) {
        throw new Error(`${difference.path} changed after the preview; rerun the pull.`);
      }
    }
  }
}

async function applyWithExclusiveLock() {
  const lockPath = path.join(ROOT, 'tmp', 'content-sync-linked.lock');
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error(
        'Another content pull owns tmp/content-sync-linked.lock; do not apply concurrently.',
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await assertCanonicalStateUnchanged();
    await replaceCanonicalSnapshot();
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

await mkdir(stagedCourseRoot, { recursive: true });
await mkdir(stagedArticleRoot, { recursive: true });
await mkdir(stagedMediaRoot, { recursive: true });
await mkdir(stagedLocalizationRoot, { recursive: true });
for (const [filePath, desired] of desiredFiles) {
  const stagedPath = stagedPathFor(filePath);
  await mkdir(path.dirname(stagedPath), { recursive: true });
  await writeFile(stagedPath, desired);
}
generateSeed({
  articlesRoot: stagedArticleRoot,
  coursesRoot: stagedCourseRoot,
  mediaRoot: stagedMediaRoot,
  localizationsRoot: stagedLocalizationRoot,
  outputPath: stagedSeedPath,
});

const [currentSeed, stagedSeed] = await Promise.all([
  readFile(SEED_PATH).catch((error) => {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }),
  readFile(stagedSeedPath),
]);
if (!currentSeed || !currentSeed.equals(stagedSeed)) {
  differences.push({
    path: 'supabase/seed.sql',
    before: currentSeed ? sha256(currentSeed) : null,
    after: sha256(stagedSeed),
  });
}
differences.sort((left, right) => left.path.localeCompare(right.path, 'en'));

const approvalRequired =
  qaRequiredSlugs.length > 0 &&
  (!visualQaApproved || approvalMissingSlugs.length > 0);
if (!approvalRequired) {
  await validateStagedSnapshot({
    articlesRoot: stagedArticleRoot,
    coursesRoot: stagedCourseRoot,
    mediaRoot: stagedMediaRoot,
    localizationsRoot: stagedLocalizationRoot,
  });
}

if (checkOnly) {
  console.log(
    JSON.stringify({
      ok: differences.length === 0,
      mode: 'check',
      catalogChecksum,
      totals,
      localizedSnapshot: {
        manifestHash: localizedSnapshot.manifest.manifestHash,
        reviewedBatchSha256: localizedSnapshot.manifest.reviewedBatchSha256,
        counts: localizedSnapshot.manifest.counts,
      },
      differences,
      presentationQa: {
        requiredCourses: qaRequiredSlugs,
        qaRoot: qaRequiredSlugs.length > 0 ? qaRoot : null,
      },
    }),
  );
  await rm(stageRoot, { recursive: true, force: true });
  if (differences.length > 0) process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: !approvalRequired,
      mode: 'preview',
      catalogChecksum,
      totals,
      localizedSnapshot: {
        manifestHash: localizedSnapshot.manifest.manifestHash,
        reviewedBatchSha256: localizedSnapshot.manifest.reviewedBatchSha256,
        counts: localizedSnapshot.manifest.counts,
      },
      differences,
      presentationQa: {
        requiredCourses: qaRequiredSlugs,
        approvalMissingCourses: approvalMissingSlugs,
        qaRoot: qaRequiredSlugs.length > 0 ? qaRoot : null,
      },
    }),
  );

  if (approvalRequired) {
    await rm(stageRoot, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        ok: false,
        mode: 'approval-required',
        message:
          'Review every rendered page/contact sheet, then rerun --pull --visual-qa-approved.',
        courses: qaRequiredSlugs,
        qaRoot,
      }),
    );
    process.exitCode = 2;
  } else if (differences.length === 0) {
    await rm(stageRoot, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        ok: true,
        mode: 'pull',
        applied: false,
        catalogChecksum,
        totals,
        localizedManifestHash: localizedSnapshot.manifest.manifestHash,
      }),
    );
  } else {
    await applyWithExclusiveLock();
    await rm(stageRoot, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        ok: true,
        mode: 'pull',
        applied: true,
        catalogChecksum,
        totals,
        localizedManifestHash: localizedSnapshot.manifest.manifestHash,
      }),
    );
  }
}
}
