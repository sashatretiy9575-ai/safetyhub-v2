import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { validateAndRenderPresentation } from './course-content/presentation-pdf-qa.mjs';
import {
  CURRENT_PRODUCTION_PROJECT_REF,
  assertCurrentProductionProjectRef,
  assertLinkedProductionProjectRef,
} from './production-operator-safety.mjs';
import {
  canonicalHash,
  loadStage6PublicationBatch,
  sha256,
  sortJson,
  Stage6PublicationContractError,
  STAGE6_ALL_LOCALES,
} from './content-localization/stage6-publication-contract.mjs';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STAGING_BUCKET = 'course-presentations-staging';
const PRESENTATION_BUCKET = 'course-presentations';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 12;

export class Stage6PublicationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Stage6PublicationError';
    this.code = code;
  }
}

function fail(code) {
  throw new Stage6PublicationError(code);
}

function optionValue(argv, name, required = true) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === name) {
      values.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  if (
    values.length > 1 ||
    (required && (!values[0] || values[0].startsWith('--'))) ||
    (values[0] && values[0].startsWith('--'))
  ) {
    fail(`STAGE6_INVALID_${name.slice(2).replaceAll('-', '_').toUpperCase()}`);
  }
  return values[0] ?? null;
}

export function parseCliArguments(argv, approvedBatchHash = null) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true, mode: 'help' };
  const modes = ['--plan', '--apply'].filter((mode) => argv.includes(mode));
  if (modes.length !== 1) fail('STAGE6_MODE_REQUIRED');
  const mode = modes[0].slice(2);
  const known = new Set([
    '--plan',
    '--apply',
    '--project-ref',
    '--actor-id',
    '--batch-hash',
    '--confirm',
    '--receipt',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (!known.has(name)) fail('STAGE6_INVALID_ARGUMENT');
    if (!argument.includes('=') && !['--plan', '--apply'].includes(name)) index += 1;
  }
  if (mode === 'plan') {
    if (argv.length !== 1) fail('STAGE6_PLAN_ARGUMENTS_FORBIDDEN');
    return { help: false, mode };
  }
  const projectRef = optionValue(argv, '--project-ref');
  const actorId = optionValue(argv, '--actor-id');
  const batchHash = optionValue(argv, '--batch-hash');
  const confirmation = optionValue(argv, '--confirm');
  const receipt = optionValue(argv, '--receipt', false);
  if (!PROJECT_REF_PATTERN.test(projectRef)) fail('STAGE6_PROJECT_REF_INVALID');
  try {
    assertCurrentProductionProjectRef(projectRef);
  } catch {
    fail('STAGE6_PROJECT_REF_NOT_CURRENT_PRODUCTION');
  }
  if (!UUID_PATTERN.test(actorId)) fail('STAGE6_ACTOR_ID_INVALID');
  if (!SHA256_PATTERN.test(batchHash)) fail('STAGE6_BATCH_HASH_INVALID');
  if (approvedBatchHash && batchHash !== approvedBatchHash) fail('STAGE6_BATCH_HASH_NOT_REVIEWED');
  if (confirmation !== `STAGE6-PUBLISH:${projectRef}:${batchHash}`) {
    fail('STAGE6_CONFIRMATION_INVALID');
  }
  return {
    help: false,
    mode,
    projectRef,
    actorId,
    batchHash,
    confirmation,
    receiptPath: receipt
      ? path.resolve(receipt)
      : path.resolve('tmp', 'stage6-publication', `${projectRef}-${batchHash}.json`),
  };
}

export function linkedEnvironment(environment, projectRef) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/u, '');
  const serviceSecret =
    environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  const operatorAccessToken = environment.SAFETYHUB_CONTENT_OPERATOR_ACCESS_TOKEN;
  if (!url || !serviceSecret || !operatorAccessToken) {
    fail('STAGE6_LINKED_CREDENTIALS_MISSING');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('STAGE6_LINKED_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== `${projectRef}.supabase.co` ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    fail('STAGE6_LINKED_PROJECT_MISMATCH');
  }
  if (
    serviceSecret.length < 20 ||
    serviceSecret.length > 4096 ||
    operatorAccessToken.length < 20 ||
    operatorAccessToken.length > 8192 ||
    /[\r\n\u0000]/u.test(serviceSecret) ||
    /[\r\n\u0000]/u.test(operatorAccessToken)
  ) {
    fail('STAGE6_LINKED_CREDENTIALS_INVALID');
  }
  return { url: parsed.origin, serviceSecret, operatorAccessToken };
}

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonEqual(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function boundedFetch(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function boundedDelay(milliseconds) {
  let remaining = Math.max(0, Math.min(milliseconds, 10 * 60 * 1000));
  while (remaining > 0) {
    const slice = Math.min(remaining, 30_000);
    await new Promise((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
  }
}

function rateLimitSeconds(error) {
  const match = `${error?.message ?? ''}`.match(/RATE_LIMITED:([0-9]{1,4})/u);
  return match ? Math.max(1, Math.min(Number(match[1]), 600)) : null;
}

function rpcEnvelopeError(data) {
  const envelope = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const payload = envelope?.__safetyhubRpcError;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const code = typeof payload.code === 'string' ? payload.code : 'P0001';
  const message = typeof payload.message === 'string' ? payload.message : 'RPC_MUTATION_FAILED';
  return { code, message };
}

function createSupabaseRepository({ url, serviceSecret, operatorAccessToken, root, batchHash }) {
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  };
  const service = createClient(url, serviceSecret, clientOptions);
  const operator = createClient(url, serviceSecret, {
    ...clientOptions,
    global: {
      ...clientOptions.global,
      headers: { Authorization: `Bearer ${operatorAccessToken}` },
    },
  });

  async function rpc(client, name, args) {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const { data, error } = await client.rpc(name, args);
      const envelope = rpcEnvelopeError(data);
      const retryAfter = rateLimitSeconds(error ?? envelope);
      if (retryAfter && attempt < MAX_RATE_LIMIT_RETRIES) {
        await boundedDelay((retryAfter + 1) * 1000);
        continue;
      }
      if (error || envelope) fail(`STAGE6_RPC_FAILED_${name.toUpperCase()}`);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        fail(`STAGE6_RPC_RECEIPT_INVALID_${name.toUpperCase()}`);
      }
      return data;
    }
    fail(`STAGE6_RPC_RETRY_EXHAUSTED_${name.toUpperCase()}`);
  }

  async function assertOperator(actorId) {
    const { data, error } = await operator.auth.getUser(operatorAccessToken);
    if (error || data?.user?.id !== actorId) fail('STAGE6_OPERATOR_SESSION_MISMATCH');
    const [courseAccess, articleAccess] = await Promise.all([
      operator.rpc('get_course_editor_localizations', {
        p_actor_id: actorId,
        p_test_id: '00000000-0000-0000-0000-000000000000',
      }),
      operator.rpc('get_article_editor_localizations', {
        p_actor_id: actorId,
        p_article_id: '00000000-0000-0000-0000-000000000000',
      }),
    ]);
    // A capability-bearing actor reaches the domain-level NOT_FOUND branch;
    // a non-admin is rejected before entity lookup.
    const courseMessage = courseAccess.error?.message ?? rpcEnvelopeError(courseAccess.data)?.message;
    const articleMessage =
      articleAccess.error?.message ?? rpcEnvelopeError(articleAccess.data)?.message;
    if (courseMessage !== 'TEST_NOT_FOUND' || articleMessage !== 'ARTICLE_NOT_FOUND') {
      fail('STAGE6_OPERATOR_CAPABILITY_MISSING');
    }
  }

  async function assertPrivateBucket(bucket) {
    const { data, error } = await service.storage.getBucket(bucket);
    if (error || !data || data.public !== false) fail(`STAGE6_BUCKET_INVALID_${bucket}`);
  }

  async function downloadObject(bucket, objectPath) {
    const { data, error } = await service.storage.from(bucket).download(objectPath);
    if (error || !data) fail(`STAGE6_STORAGE_DOWNLOAD_FAILED_${bucket}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async function ensureObject(bucket, objectPath, bytes, contentType, immutable) {
    const { error } = await service.storage.from(bucket).upload(objectPath, bytes, {
      upsert: false,
      contentType,
      cacheControl: immutable ? '31536000, immutable' : '0',
    });
    if (error && !/already exists|duplicate/iu.test(error.message)) {
      fail(`STAGE6_STORAGE_UPLOAD_FAILED_${bucket}`);
    }
    const existing = await downloadObject(bucket, objectPath);
    if (!existing.equals(bytes)) fail(`STAGE6_IMMUTABLE_OBJECT_CONFLICT_${bucket}`);
    return error ? 'verified' : 'uploaded';
  }

  async function validThumbnail(bytes) {
    const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: 4_000_000 })
      .metadata()
      .catch(() => null);
    return Boolean(
      metadata?.format === 'webp' &&
        metadata.width &&
        metadata.height &&
        metadata.width <= 1600 &&
        metadata.height <= 1600 &&
        Math.abs(metadata.width / metadata.height - 16 / 9) <= 0.02,
    );
  }

  async function generatedPresentationThumbnail(item) {
    const qaRoot = path.join(
      root,
      'tmp',
      'stage6-publication',
      batchHash,
      'presentation-qa',
    );
    const result = await validateAndRenderPresentation({
      slug: `${item.slug}-${item.locale}`,
      pdfBytes: item.presentation.pdf.bytes,
      thumbnailBytes: null,
      expectedByteSize: item.presentation.byteSize,
      expectedPageCount: item.presentation.pageCount,
      expectedSha256: item.presentation.sha256,
      qaRoot,
      visualQaApproved: true,
      reviewedAt: '2026-09-02T00:00:00.000Z',
    });
    if (
      result?.manifest?.sha256 !== item.presentation.sha256 ||
      result?.manifest?.pageCount !== item.presentation.pageCount ||
      !Buffer.isBuffer(result.thumbnailBytes) ||
      !(await validThumbnail(result.thumbnailBytes))
    ) {
      fail('STAGE6_PRESENTATION_RUNTIME_QA_FAILED');
    }
    return result.thumbnailBytes;
  }

  async function ensurePresentation(item, actorId) {
    const existingReady = await service
      .from('course_presentations')
      .select('*')
      .eq('course_id', item.courseId)
      .eq('locale', item.locale)
      .eq('sha256', item.presentation.sha256)
      .eq('status', 'ready')
      .maybeSingle();
    if (existingReady.error) fail('STAGE6_PRESENTATION_LOOKUP_FAILED');
    if (existingReady.data) {
      const row = existingReady.data;
      const expectedPrefix = `${item.courseId}/${item.locale}/${row.id}`;
      if (
        row.storage_bucket !== PRESENTATION_BUCKET ||
        row.storage_path !== `${expectedPrefix}/${item.presentation.sha256}.pdf` ||
        row.thumbnail_path !== `${expectedPrefix}/${item.presentation.sha256}-thumb.webp` ||
        Number(row.byte_size) !== item.presentation.byteSize ||
        Number(row.page_count) !== item.presentation.pageCount
      ) {
        fail('STAGE6_PRESENTATION_READY_METADATA_CONFLICT');
      }
      const [pdf, thumbnail] = await Promise.all([
        downloadObject(PRESENTATION_BUCKET, row.storage_path),
        downloadObject(PRESENTATION_BUCKET, row.thumbnail_path),
      ]);
      if (
        sha256(pdf) !== item.presentation.sha256 ||
        pdf.length !== item.presentation.byteSize ||
        !(await validThumbnail(thumbnail))
      ) {
        fail('STAGE6_PRESENTATION_READY_OBJECT_CONFLICT');
      }
      return { id: row.id, sha256: row.sha256, pageCount: Number(row.page_count), replayed: true };
    }

    const presentationId = deterministicUuid(
      `stage6:${batchHash}:${item.courseId}:${item.locale}:${item.presentation.sha256}`,
    );
    const stagingPdfPath = `${actorId}/${presentationId}/source.pdf`;
    const stagingThumbnailPath = `${actorId}/${presentationId}/thumbnail.webp`;
    const publicPrefix = `${item.courseId}/${item.locale}/${presentationId}`;
    const publicPdfPath = `${publicPrefix}/${item.presentation.sha256}.pdf`;
    const publicThumbnailPath = `${publicPrefix}/${item.presentation.sha256}-thumb.webp`;
    const thumbnail = await generatedPresentationThumbnail(item);
    const found = await service
      .from('course_presentations')
      .select('*')
      .eq('id', presentationId)
      .maybeSingle();
    if (found.error) fail('STAGE6_PRESENTATION_LOOKUP_FAILED');
    let row = found.data;
    if (!row) {
      const inserted = await service.from('course_presentations').insert({
        id: presentationId,
        course_id: item.courseId,
        locale: item.locale,
        storage_bucket: STAGING_BUCKET,
        storage_path: stagingPdfPath,
        thumbnail_path: stagingThumbnailPath,
        source_filename: item.presentation.sourceFilename,
        mime_type: 'application/pdf',
        byte_size: item.presentation.byteSize,
        sha256: item.presentation.sha256,
        page_count: item.presentation.pageCount,
        aspect_ratio: '16:9',
        status: 'staging',
        created_by: actorId,
      });
      if (inserted.error) fail('STAGE6_PRESENTATION_METADATA_INSERT_FAILED');
      row = { status: 'staging' };
    } else if (
      row.course_id !== item.courseId ||
      row.locale !== item.locale ||
      row.created_by !== actorId ||
      row.sha256 !== item.presentation.sha256 ||
      Number(row.byte_size) !== item.presentation.byteSize ||
      Number(row.page_count) !== item.presentation.pageCount ||
      row.storage_bucket !== STAGING_BUCKET ||
      row.storage_path !== stagingPdfPath ||
      row.thumbnail_path !== stagingThumbnailPath ||
      !['staging', 'validating'].includes(row.status)
    ) {
      fail('STAGE6_PRESENTATION_RESUME_CONFLICT');
    }
    await Promise.all([
      ensureObject(
        STAGING_BUCKET,
        stagingPdfPath,
        item.presentation.pdf.bytes,
        'application/pdf',
        false,
      ),
      ensureObject(STAGING_BUCKET, stagingThumbnailPath, thumbnail, 'image/webp', false),
    ]);
    if (row.status === 'staging') {
      const validating = await service
        .from('course_presentations')
        .update({ status: 'validating', validation_error: null })
        .eq('id', presentationId)
        .eq('status', 'staging')
        .select('id')
        .maybeSingle();
      if (validating.error || !validating.data) fail('STAGE6_PRESENTATION_VALIDATING_FAILED');
    }
    await Promise.all([
      ensureObject(
        PRESENTATION_BUCKET,
        publicPdfPath,
        item.presentation.pdf.bytes,
        'application/pdf',
        true,
      ),
      ensureObject(PRESENTATION_BUCKET, publicThumbnailPath, thumbnail, 'image/webp', true),
    ]);
    const finalized = await rpc(service, 'finalize_course_presentation_metadata', {
      p_actor_id: actorId,
      p_course_id: item.courseId,
      p_presentation_id: presentationId,
      p_expected_sha256: item.presentation.sha256,
      p_expected_page_count: item.presentation.pageCount,
      p_expected_byte_size: item.presentation.byteSize,
      p_expected_staging_pdf_path: stagingPdfPath,
      p_expected_staging_thumbnail_path: stagingThumbnailPath,
    });
    if (
      finalized.presentation?.id !== presentationId ||
      finalized.presentation?.courseId !== item.courseId ||
      finalized.presentation?.locale !== item.locale ||
      finalized.presentation?.storagePath !== publicPdfPath ||
      finalized.presentation?.thumbnailPath !== publicThumbnailPath ||
      finalized.presentation?.sha256 !== item.presentation.sha256 ||
      finalized.presentation?.status !== 'ready'
    ) {
      fail('STAGE6_PRESENTATION_FINALIZE_RECEIPT_INVALID');
    }
    const cleanup = finalized.cleanup;
    if (cleanup) {
      const removed = await service.storage
        .from(STAGING_BUCKET)
        .remove([stagingPdfPath, stagingThumbnailPath]);
      if (!removed.error) {
        await rpc(service, 'complete_course_presentation_cleanup', {
          p_presentation_ids: [cleanup.id],
        });
      }
    }
    return {
      id: presentationId,
      sha256: item.presentation.sha256,
      pageCount: item.presentation.pageCount,
      replayed: Boolean(finalized.replayed),
    };
  }

  async function tableRows(table, columns, filters) {
    let query = service.from(table).select(columns);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) fail(`STAGE6_STATE_READ_FAILED_${table.toUpperCase()}`);
    return data;
  }

  async function oneRow(table, columns, filters) {
    let query = service.from(table).select(columns);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query.maybeSingle();
    if (error) fail(`STAGE6_STATE_READ_FAILED_${table.toUpperCase()}`);
    return data;
  }

  async function readCourse(courseId) {
    const test = await oneRow(
      'tests',
      'id,slug,status,current_revision_id,content_version',
      { id: courseId },
    );
    const draft = await oneRow('course_drafts', 'test_id,content_hash,draft_version', {
      test_id: courseId,
    });
    if (!test || !draft) fail('STAGE6_COURSE_NOT_FOUND');
    const [draftLocalizations, draftMappings, presentations] = await Promise.all([
      tableRows(
        'course_draft_localizations',
        'test_id,locale,title,description,content,question_variants,seo,sources,content_hash,reviewed_content_hash,translation_qa,status,draft_version',
        { test_id: courseId },
      ),
      tableRows('course_draft_presentations', 'test_id,locale,presentation_id', {
        test_id: courseId,
      }),
      tableRows(
        'course_presentations',
        'id,course_id,locale,status,sha256,page_count,byte_size,storage_bucket,storage_path,thumbnail_path',
        { course_id: courseId },
      ),
    ]);
    let current = null;
    if (test.current_revision_id) {
      const [localizations, variants, variantLocalizations, mappings] = await Promise.all([
        tableRows(
          'test_revision_localizations',
          'revision_id,locale,title,description,content,seo,sources,content_hash,translation_qa',
          { revision_id: test.current_revision_id },
        ),
        tableRows('test_revision_variants', 'id,stable_id,variant_number,question_count', {
          revision_id: test.current_revision_id,
        }),
        tableRows(
          'test_revision_variant_localizations',
          'revision_id,variant_id,locale,questions,explanations,question_count,structure_hash,content_hash',
          { revision_id: test.current_revision_id },
        ),
        tableRows('test_revision_presentations', 'revision_id,locale,presentation_id', {
          revision_id: test.current_revision_id,
        }),
      ]);
      current = { revisionId: test.current_revision_id, localizations, variants, variantLocalizations, mappings };
    }
    return { test, draft, draftLocalizations, draftMappings, presentations, current };
  }

  async function saveCourseLocalization(args) {
    return rpc(operator, 'save_course_localization_draft', args);
  }

  async function importCourseAssessment(args) {
    return rpc(service, 'import_course_assessment_localization', args);
  }

  async function publishCourse(args) {
    return rpc(operator, 'publish_course_revision_v4', args);
  }

  async function readArticle(slug) {
    const article = await oneRow(
      'articles',
      'id,slug,status,is_published,current_revision_id,content_version',
      { slug },
    );
    if (!article) fail('STAGE6_ARTICLE_NOT_FOUND');
    const draft = await oneRow(
      'article_drafts',
      'article_id,slug,title,description,cover_image,blocks,seo,sources,content_hash,draft_version',
      { article_id: article.id },
    );
    if (!draft) fail('STAGE6_ARTICLE_DRAFT_NOT_FOUND');
    const draftLocalizations = await tableRows(
      'article_draft_localizations',
      'article_id,locale,title,description,blocks,seo,sources,content_hash,reviewed_content_hash,translation_qa,status,draft_version',
      { article_id: article.id },
    );
    let current = null;
    if (article.current_revision_id) {
      current = {
        revisionId: article.current_revision_id,
        localizations: await tableRows(
          'article_revision_localizations',
          'revision_id,locale,title,description,blocks,seo,sources,content_hash,translation_qa',
          { revision_id: article.current_revision_id },
        ),
      };
    }
    return { article, draft, draftLocalizations, current };
  }

  async function saveArticleLocalization(args) {
    return rpc(operator, 'save_article_localization_draft', args);
  }

  async function publishArticle(args) {
    return rpc(operator, 'publish_article_revision_v3', args);
  }

  async function readLegal(documentType, version) {
    const versionRow = await oneRow(
      'legal_document_versions',
      'document_type,version,body_revision,effective_at,is_current',
      { document_type: documentType, version },
    );
    const localizations = await tableRows(
      'legal_document_localizations',
      'document_type,version,locale,title,body,body_hash,status',
      { document_type: documentType, version },
    );
    return { version: versionRow, localizations };
  }

  async function stageLegal(args) {
    return rpc(operator, 'stage_legal_document_version', args);
  }

  async function saveLegal(args) {
    return rpc(operator, 'save_legal_document_localization', args);
  }

  async function publishLegalBundle(args) {
    return rpc(operator, 'publish_legal_document_bundle', args);
  }

  return {
    assertOperator,
    assertPrivateBucket,
    ensurePresentation,
    readCourse,
    saveCourseLocalization,
    importCourseAssessment,
    publishCourse,
    readArticle,
    saveArticleLocalization,
    publishArticle,
    readLegal,
    stageLegal,
    saveLegal,
    publishLegalBundle,
  };
}

function expectedVariantProjection(variant) {
  return {
    questions: variant.questions.map(
      (question, questionIndex) => ({
        id: question.id,
        text: question.text,
        displayOrder: questionIndex + 1,
        options: question.options.map((option, optionIndex) => ({
          id: option.id,
          text: option.text,
          displayOrder: optionIndex + 1,
        })),
      }),
    ),
    explanations: variant.questions.map((question) => question.explanation ?? ''),
  };
}

function localizedDocumentMatches(row, source, kind) {
  if (!row) return false;
  if (kind === 'course') {
    return (
      row.title === source.title &&
      row.description === source.description &&
      jsonEqual(row.content, source.content) &&
      jsonEqual(row.seo, source.seo) &&
      jsonEqual(row.sources, source.sources)
    );
  }
  return (
    row.title === source.title &&
    row.description === source.description &&
    jsonEqual(row.blocks, source.blocks) &&
    jsonEqual(row.seo, source.seo) &&
    jsonEqual(row.sources, source.sources)
  );
}

function currentCourseMatches(state, entries, reviewedBatchSha256) {
  if (!state.current) return false;
  const presentationById = new Map(state.presentations.map((row) => [row.id, row]));
  const variantsByStableId = new Map(state.current.variants.map((row) => [row.stable_id, row]));
  for (const entry of entries) {
    const localization = state.current.localizations.find((row) => row.locale === entry.locale);
    if (
      !localizedDocumentMatches(localization, entry.draft, 'course') ||
      localization.translation_qa?.batchSha256 !== reviewedBatchSha256
    ) {
      return false;
    }
    const mapping = state.current.mappings.find((row) => row.locale === entry.locale);
    const presentation = presentationById.get(mapping?.presentation_id);
    if (
      !presentation ||
      presentation.status !== 'ready' ||
      presentation.locale !== entry.locale ||
      presentation.sha256 !== entry.presentation.sha256 ||
      Number(presentation.page_count) !== entry.presentation.pageCount
    ) {
      return false;
    }
    for (const expectedVariant of entry.assessment.questionVariants) {
      const variant = variantsByStableId.get(expectedVariant.id);
      if (!variant || variant.variant_number !== expectedVariant.variantNumber) return false;
      const localized = state.current.variantLocalizations.find(
        (row) => row.variant_id === variant.id && row.locale === entry.locale,
      );
      const expected = expectedVariantProjection(expectedVariant);
      if (
        !localized ||
        !jsonEqual(localized.questions, expected.questions) ||
        !jsonEqual(localized.explanations, expected.explanations)
      ) {
        return false;
      }
    }
  }
  return true;
}

function currentArticlesMatch(state, entries, reviewedBatchSha256) {
  if (!state.current) return false;
  return entries.every((entry) => {
    const localization = state.current.localizations.find(
      (row) => row.locale === entry.locale,
    );
    return (
      localizedDocumentMatches(localization, entry.document, 'article') &&
      localization.translation_qa?.batchSha256 === reviewedBatchSha256
    );
  });
}

function reviewedQa(batch) {
  return {
    status: 'passed',
    mode: 'automated-only',
    batchId: batch.batchId,
    batchSha256: batch.batchHash,
    artifactManifestSha256: batch.artifactManifestHash,
    independentSemanticReviewSha256: batch.review.independentSemanticReviewSha256,
    humanApproval: false,
  };
}

function courseSaveArgs(actorId, entry, presentationId, expectedVersion, reviewHash, qa) {
  return {
    p_actor_id: actorId,
    p_test_id: entry.courseId,
    p_locale: entry.locale,
    p_expected_version: expectedVersion,
    p_title: entry.draft.title,
    p_description: entry.draft.description,
    p_content: entry.draft.content,
    p_question_variants: [],
    p_seo: entry.draft.seo,
    p_sources: entry.draft.sources,
    p_reviewed_content_hash: reviewHash,
    p_translation_qa: qa,
    p_presentation_id: presentationId,
  };
}

function sanitizedDigest(items) {
  return canonicalHash(
    items.map((item) => sortJson(item)).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'),
    ),
  );
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function legalRowsArePublished(state) {
  return (
    state?.localizations?.length === STAGE6_ALL_LOCALES.length &&
    STAGE6_ALL_LOCALES.every(
      (locale) => state.localizations.find((row) => row.locale === locale)?.status === 'published',
    )
  );
}

function legalRowsAreComplete(state) {
  return (
    state?.localizations?.length === STAGE6_ALL_LOCALES.length &&
    STAGE6_ALL_LOCALES.every(
      (locale) => state.localizations.find((row) => row.locale === locale)?.status === 'complete',
    )
  );
}

function legalVersionMatchesStage(document, state) {
  if (
    !state?.version ||
    state.version.body_revision !== document.stageArgs.p_body_revision
  ) {
    return false;
  }
  const expectedEffectiveAt = new Date(document.stageArgs.p_effective_at);
  const actualEffectiveAt = new Date(state.version.effective_at);
  return (
    !Number.isNaN(expectedEffectiveAt.valueOf()) &&
    !Number.isNaN(actualEffectiveAt.valueOf()) &&
    actualEffectiveAt.toISOString() === expectedEffectiveAt.toISOString()
  );
}

function historicalLegalMatches(document, state) {
  return (
    legalRowsArePublished(state) &&
    document.historical.every((localization) => {
      const row = state.localizations.find((item) => item.locale === localization.locale);
      return (
        row?.title === localization.title &&
        jsonEqual(row.body, localization.body)
      );
    })
  );
}

function currentLegalMatches(document, state, { requireCurrent = false } = {}) {
  return (
    legalVersionMatchesStage(document, state) &&
    (!requireCurrent || state.version.is_current) &&
    legalRowsArePublished(state) &&
    document.localizations.every((localization) => {
      const row = state.localizations.find((item) => item.locale === localization.locale);
      return (
        row?.title === localization.args.p_title &&
        jsonEqual(row.body, localization.args.p_body)
      );
    })
  );
}

export async function executeStage6Publication({
  options,
  environment = process.env,
  root = process.cwd(),
  repository = null,
  skipLinkedProjectCheck = false,
  validateRelease = true,
} = {}) {
  const batch = await loadStage6PublicationBatch({ root, validateRelease });
  if (options.batchHash !== batch.batchHash) fail('STAGE6_BATCH_HASH_NOT_REVIEWED');
  if (!skipLinkedProjectCheck) {
    try {
      await assertLinkedProductionProjectRef(options.projectRef);
    } catch {
      fail('STAGE6_LINKED_PROJECT_CONFIRMATION_FAILED');
    }
  }
  let repo = repository;
  if (!repo) {
    const linked = linkedEnvironment(environment, options.projectRef);
    repo = createSupabaseRepository({ ...linked, root, batchHash: batch.batchHash });
  }
  await repo.assertOperator(options.actorId);
  await Promise.all([
    repo.assertPrivateBucket(STAGING_BUCKET),
    repo.assertPrivateBucket(PRESENTATION_BUCKET),
  ]);

  const qa = reviewedQa(batch);
  const presentationResults = [];
  const presentationIds = new Map();
  for (const item of batch.courses) {
    const result = await repo.ensurePresentation(item, options.actorId);
    if (
      !UUID_PATTERN.test(result?.id ?? '') ||
      result.sha256 !== item.presentation.sha256 ||
      result.pageCount !== item.presentation.pageCount
    ) {
      fail('STAGE6_PRESENTATION_RESULT_INVALID');
    }
    presentationIds.set(`${item.courseId}:${item.locale}`, result.id);
    presentationResults.push({
      locale: item.locale,
      sha256: result.sha256,
      pageCount: result.pageCount,
      replayed: Boolean(result.replayed),
    });
  }

  const courseResults = [];
  for (const slug of [...new Set(batch.courses.map((item) => item.slug))].sort()) {
    const entries = batch.courses.filter((item) => item.slug === slug);
    let state = await repo.readCourse(entries[0].courseId);
    if (state.test.slug !== slug) fail('STAGE6_COURSE_IDENTITY_CONFLICT');
    let published = false;
    if (!currentCourseMatches(state, entries, batch.batchHash)) {
      for (const entry of entries) {
        const presentationId = presentationIds.get(`${entry.courseId}:${entry.locale}`);
        let localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        const mapping = state.draftMappings.find((row) => row.locale === entry.locale);
        if (
          !localizedDocumentMatches(localization, entry.draft, 'course') ||
          mapping?.presentation_id !== presentationId
        ) {
          await repo.saveCourseLocalization(
            courseSaveArgs(
              options.actorId,
              entry,
              presentationId,
              localization?.draft_version ?? null,
              null,
              qa,
            ),
          );
          state = await repo.readCourse(entry.courseId);
          localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        }
        if (!localization) fail('STAGE6_COURSE_LOCALIZATION_SAVE_MISSING');
        if (!jsonEqual(localization.question_variants, entry.assessment.questionVariants)) {
          await repo.importCourseAssessment({
            p_actor_id: options.actorId,
            p_test_id: entry.courseId,
            p_locale: entry.locale,
            p_expected_version: localization.draft_version,
            p_question_variants: entry.assessment.questionVariants,
          });
          state = await repo.readCourse(entry.courseId);
          localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        }
        if (!localization) fail('STAGE6_COURSE_ASSESSMENT_IMPORT_MISSING');
        const completionQa = {
          ...localization.translation_qa,
          ...qa,
          assessmentImported: true,
        };
        if (
          localization.status !== 'complete' ||
          localization.reviewed_content_hash !== localization.content_hash ||
          !localizedDocumentMatches(localization, entry.draft, 'course') ||
          !jsonEqual(localization.question_variants, entry.assessment.questionVariants) ||
          localization.translation_qa?.batchSha256 !== batch.batchHash
        ) {
          await repo.saveCourseLocalization(
            courseSaveArgs(
              options.actorId,
              entry,
              presentationId,
              localization.draft_version,
              localization.content_hash,
              completionQa,
            ),
          );
          state = await repo.readCourse(entry.courseId);
          localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        }
        if (
          !localization ||
          localization.status !== 'complete' ||
          localization.reviewed_content_hash !== localization.content_hash ||
          !jsonEqual(localization.question_variants, entry.assessment.questionVariants)
        ) {
          fail('STAGE6_COURSE_LOCALIZATION_NOT_COMPLETE');
        }
      }
      state = await repo.readCourse(entries[0].courseId);
      const publish = await repo.publishCourse({
        p_actor_id: options.actorId,
        p_test_id: entries[0].courseId,
        p_expected_content_hash: state.draft.content_hash,
      });
      if (!UUID_PATTERN.test(publish?.revisionId ?? '') || publish?.locales?.length !== 4) {
        fail('STAGE6_COURSE_PUBLICATION_RECEIPT_INVALID');
      }
      published = true;
      state = await repo.readCourse(entries[0].courseId);
    }
    if (!currentCourseMatches(state, entries, batch.batchHash)) {
      fail('STAGE6_COURSE_HOSTED_PARITY_FAILED');
    }
    courseResults.push({
      keyHash: sha256(Buffer.from(`course:${slug}`, 'utf8')),
      published,
      version: state.test.content_version,
      localizedContentHashes: entries
        .map((entry) => ({
          locale: entry.locale,
          contentHash: state.current.localizations.find((row) => row.locale === entry.locale)
            ?.content_hash,
        }))
        .sort((left, right) => left.locale.localeCompare(right.locale, 'en')),
    });
  }

  const articleResults = [];
  for (const slug of [...new Set(batch.articles.map((item) => item.slug))].sort()) {
    const entries = batch.articles.filter((item) => item.slug === slug);
    let state = await repo.readArticle(slug);
    let published = false;
    if (!currentArticlesMatch(state, entries, batch.batchHash)) {
      for (const entry of entries) {
        let localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        if (!localizedDocumentMatches(localization, entry.document, 'article')) {
          await repo.saveArticleLocalization({
            p_actor_id: options.actorId,
            p_article_id: state.article.id,
            p_locale: entry.locale,
            p_expected_version: localization?.draft_version ?? null,
            p_title: entry.document.title,
            p_description: entry.document.description,
            p_blocks: entry.document.blocks,
            p_seo: entry.document.seo,
            p_sources: entry.document.sources,
            p_reviewed_content_hash: null,
            p_translation_qa: qa,
          });
          state = await repo.readArticle(slug);
          localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        }
        if (!localization) fail('STAGE6_ARTICLE_LOCALIZATION_SAVE_MISSING');
        if (
          localization.status !== 'complete' ||
          localization.reviewed_content_hash !== localization.content_hash ||
          localization.translation_qa?.batchSha256 !== batch.batchHash
        ) {
          await repo.saveArticleLocalization({
            p_actor_id: options.actorId,
            p_article_id: state.article.id,
            p_locale: entry.locale,
            p_expected_version: localization.draft_version,
            p_title: entry.document.title,
            p_description: entry.document.description,
            p_blocks: entry.document.blocks,
            p_seo: entry.document.seo,
            p_sources: entry.document.sources,
            p_reviewed_content_hash: localization.content_hash,
            p_translation_qa: qa,
          });
          state = await repo.readArticle(slug);
          localization = state.draftLocalizations.find((row) => row.locale === entry.locale);
        }
        if (
          !localization ||
          localization.status !== 'complete' ||
          localization.reviewed_content_hash !== localization.content_hash
        ) {
          fail('STAGE6_ARTICLE_LOCALIZATION_NOT_COMPLETE');
        }
      }
      state = await repo.readArticle(slug);
      const publish = await repo.publishArticle({
        p_actor_id: options.actorId,
        p_article_id: state.article.id,
        p_expected_content_hash: state.draft.content_hash,
      });
      if (!UUID_PATTERN.test(publish?.revisionId ?? '') || publish?.locales?.length !== 4) {
        fail('STAGE6_ARTICLE_PUBLICATION_RECEIPT_INVALID');
      }
      published = true;
      state = await repo.readArticle(slug);
    }
    if (!currentArticlesMatch(state, entries, batch.batchHash)) {
      fail('STAGE6_ARTICLE_HOSTED_PARITY_FAILED');
    }
    articleResults.push({
      keyHash: sha256(Buffer.from(`article:${slug}`, 'utf8')),
      published,
      version: state.article.content_version,
      localizedContentHashes: entries
        .map((entry) => ({
          locale: entry.locale,
          contentHash: state.current.localizations.find((row) => row.locale === entry.locale)
            ?.content_hash,
        }))
        .sort((left, right) => left.locale.localeCompare(right.locale, 'en')),
    });
  }

  // The frozen Stage 6 receipt predates paired legal activation. It may be
  // replayed only from a coherent four-locale historical pair; an old RU-only
  // state fails closed instead of invoking the disabled single-document RPC.
  const historicalLegal = await Promise.all(
    batch.legal.map(async (document) => ({
      document,
      state: await repo.readLegal(document.documentType, document.historicalVersion),
    })),
  );
  for (const { document, state } of historicalLegal) {
    if (!state.version) fail('STAGE6_HISTORICAL_LEGAL_VERSION_MISSING');
    if (!historicalLegalMatches(document, state)) {
      fail('STAGE6_HISTORICAL_LEGAL_BUNDLE_PREREQUISITE_REQUIRED');
    }
  }

  let currentLegal = await Promise.all(
    batch.legal.map(async (document) => ({
      document,
      state: await repo.readLegal(document.documentType, document.version),
    })),
  );
  if (
    !currentLegal.every(({ document, state }) =>
      currentLegalMatches(document, state, { requireCurrent: true }),
    )
  ) {
    if (currentLegal.every(({ document, state }) => currentLegalMatches(document, state))) {
      fail('STAGE6_CURRENT_LEGAL_BUNDLE_SUPERSEDED');
    }
    if (
      currentLegal.some(
        ({ state }) =>
          state.version?.is_current ||
          state.localizations?.some((localization) => localization.status === 'published'),
      )
    ) {
      fail('STAGE6_CURRENT_LEGAL_BUNDLE_MIXED_STATE');
    }
    if (!historicalLegal.every(({ state }) => state.version?.is_current)) {
      fail('STAGE6_HISTORICAL_LEGAL_BUNDLE_PREREQUISITE_REQUIRED');
    }
    const privacyVersion = batch.legal.find(
      (document) => document.documentType === 'privacy',
    )?.version;
    const termsVersion = batch.legal.find(
      (document) => document.documentType === 'terms',
    )?.version;
    if (
      !privacyVersion ||
      !termsVersion ||
      batch.legalBundle?.args?.p_privacy_version !== privacyVersion ||
      batch.legalBundle?.args?.p_terms_version !== termsVersion
    ) {
      fail('STAGE6_CURRENT_LEGAL_BUNDLE_INVALID');
    }

    const preparedLegal = [];
    for (const { document, state: initialState } of currentLegal) {
      let current = initialState;
      if (!current.version) {
        await repo.stageLegal(document.stageArgs);
        current = await repo.readLegal(document.documentType, document.version);
      }
      if (!legalVersionMatchesStage(document, current)) {
        fail('STAGE6_CURRENT_LEGAL_VERSION_CONFLICT');
      }
      for (const localization of document.localizations) {
        const row = current.localizations.find((item) => item.locale === localization.locale);
        if (row?.status === 'published') {
          if (
            row.title !== localization.args.p_title ||
            !jsonEqual(row.body, localization.args.p_body)
          ) {
            fail('STAGE6_CURRENT_LEGAL_IMMUTABLE_CONFLICT');
          }
          fail('STAGE6_CURRENT_LEGAL_BUNDLE_MIXED_STATE');
        }
        if (
          !row ||
          row.title !== localization.args.p_title ||
          !jsonEqual(row.body, localization.args.p_body) ||
          row.status !== 'complete'
        ) {
          await repo.saveLegal(localization.args);
          current = await repo.readLegal(document.documentType, document.version);
        }
      }
      if (!legalRowsAreComplete(current)) {
        fail('STAGE6_CURRENT_LEGAL_LOCALIZATION_NOT_COMPLETE');
      }
      preparedLegal.push({ document, state: current });
    }

    if (preparedLegal.length !== batch.legal.length) {
      fail('STAGE6_CURRENT_LEGAL_BUNDLE_PREPARE_FAILED');
    }
    const publication = await repo.publishLegalBundle(batch.legalBundle.args);
    if (
      publication?.privacy?.version !== batch.legalBundle.args.p_privacy_version ||
      publication?.terms?.version !== batch.legalBundle.args.p_terms_version ||
      !Array.isArray(publication?.locales) ||
      publication.locales.length !== STAGE6_ALL_LOCALES.length
    ) {
      fail('STAGE6_CURRENT_LEGAL_BUNDLE_RECEIPT_INVALID');
    }
    currentLegal = await Promise.all(
      batch.legal.map(async (document) => ({
        document,
        state: await repo.readLegal(document.documentType, document.version),
      })),
    );
    if (
      !currentLegal.every(({ document, state }) =>
        currentLegalMatches(document, state, { requireCurrent: true }),
      )
    ) {
      fail('STAGE6_CURRENT_LEGAL_PUBLICATION_FAILED');
    }
  }

  const legalResults = currentLegal.map(({ document, state }) => ({
    keyHash: sha256(
      Buffer.from(`legal:${document.documentType}:${document.version}`, 'utf8'),
    ),
    version: document.version,
    localeHashes: state.localizations
      .map((row) => ({ locale: row.locale, bodyHash: row.body_hash }))
      .sort((left, right) => left.locale.localeCompare(right.locale, 'en')),
  }));

  const receipt = {
    schemaVersion: 1,
    mode: 'stage6-controlled-publication',
    status: 'completed',
    productionPublished: true,
    projectRef: options.projectRef,
    batchId: batch.batchId,
    batchSha256: batch.batchHash,
    artifactManifestSha256: batch.artifactManifestHash,
    counts: {
      ...batch.counts,
      publishedCourseRevisions: courseResults.filter((item) => item.published).length,
      reusedCourseRevisions: courseResults.filter((item) => !item.published).length,
      publishedArticleRevisions: articleResults.filter((item) => item.published).length,
      reusedArticleRevisions: articleResults.filter((item) => !item.published).length,
    },
    hashes: {
      presentations: sanitizedDigest(
        presentationResults.map(({ replayed: _replayed, ...item }) => item),
      ),
      courses: sanitizedDigest(
        courseResults.map(({ published: _published, ...item }) => item),
      ),
      articles: sanitizedDigest(
        articleResults.map(({ published: _published, ...item }) => item),
      ),
      legal: sanitizedDigest(legalResults),
    },
    answerKeysIncluded: false,
    operationalPiiIncluded: false,
    completedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(options.receiptPath), { recursive: true });
  let persistedReceipt = receipt;
  try {
    await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(options.receiptPath, 'utf8'));
    const receiptKeys = [
      'schemaVersion',
      'mode',
      'status',
      'productionPublished',
      'projectRef',
      'batchId',
      'batchSha256',
      'artifactManifestSha256',
      'counts',
      'hashes',
      'answerKeysIncluded',
      'operationalPiiIncluded',
      'completedAt',
    ];
    const countKeys = Object.keys(receipt.counts);
    if (
      !exactKeys(existing, receiptKeys) ||
      !exactKeys(existing?.counts, countKeys) ||
      !exactKeys(existing?.hashes, Object.keys(receipt.hashes)) ||
      existing?.status !== 'completed' ||
      existing?.schemaVersion !== 1 ||
      existing?.mode !== 'stage6-controlled-publication' ||
      existing?.productionPublished !== true ||
      existing?.answerKeysIncluded !== false ||
      existing?.operationalPiiIncluded !== false ||
      existing?.projectRef !== receipt.projectRef ||
      existing?.batchId !== receipt.batchId ||
      existing?.batchSha256 !== receipt.batchSha256 ||
      existing?.artifactManifestSha256 !== receipt.artifactManifestSha256 ||
      Object.entries(batch.counts).some(
        ([key, value]) => existing.counts?.[key] !== value,
      ) ||
      existing.counts?.publishedCourseRevisions +
          existing.counts?.reusedCourseRevisions !==
        batch.counts.courses ||
      existing.counts?.publishedArticleRevisions +
          existing.counts?.reusedArticleRevisions !==
        batch.counts.articles ||
      Object.values(existing.counts).some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      !Number.isFinite(new Date(existing.completedAt).getTime()) ||
      !jsonEqual(existing.hashes, receipt.hashes)
    ) {
      fail('STAGE6_PUBLICATION_RECEIPT_CONFLICT');
    }
    persistedReceipt = existing;
  }
  return { receipt: persistedReceipt, receiptPath: options.receiptPath };
}

export async function runCli({ argv = process.argv.slice(2), environment = process.env } = {}) {
  try {
    const preliminary = parseCliArguments(argv);
    if (preliminary.help) {
      return {
        exitCode: 0,
        output: {
          ok: true,
          usage:
            'npm run content:localizations:publish:plan | npm run content:localizations:publish -- --project-ref <ref> --actor-id <uuid> --batch-hash <sha256> --confirm STAGE6-PUBLISH:<ref>:<sha256>',
        },
      };
    }
    const batch = await loadStage6PublicationBatch();
    if (preliminary.mode === 'plan') {
      return {
        exitCode: 0,
        output: {
          ok: true,
          mode: 'plan',
          productionPublished: false,
          currentProductionProjectRef: CURRENT_PRODUCTION_PROJECT_REF,
          batchId: batch.batchId,
          batchSha256: batch.batchHash,
          artifactManifestSha256: batch.artifactManifestHash,
          counts: batch.counts,
          requiredConfirmation: `STAGE6-PUBLISH:<project-ref>:${batch.batchHash}`,
        },
      };
    }
    const options = parseCliArguments(argv, batch.batchHash);
    const result = await executeStage6Publication({ options, environment });
    return {
      exitCode: 0,
      output: { ok: true, ...result.receipt, receiptPath: result.receiptPath },
    };
  } catch (error) {
    const code =
      error instanceof Stage6PublicationError ||
      error instanceof Stage6PublicationContractError
        ? error.message
        : 'STAGE6_PUBLICATION_FAILED';
    return { exitCode: 1, output: { ok: false, error: code } };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const execution = await runCli();
  console.log(JSON.stringify(execution.output));
  process.exitCode = execution.exitCode;
}
