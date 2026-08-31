import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLIC_PRESENTATION_BUCKET = 'course-presentations';
const MAX_PRESENTATION_BYTES = 25 * 1024 * 1024;
const MAX_THUMBNAIL_PIXELS = 4_000_000;
const MAX_THUMBNAIL_EDGE = 1_600;
const ASPECT_RATIO_TOLERANCE = 0.02;
const LINKED_REQUEST_TIMEOUT_MS = 45_000;
const CANONICAL_SLUGS = [
  'plotnik',
  'armaturshchik',
  'lesomontazhnye-raboty',
  'biot',
  'pozharnaya-bezopasnost',
];

class SafeCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SafeCheckError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function safeCode(error, fallback) {
  return error instanceof SafeCheckError ? error.code : fallback;
}

async function boundedFetch(input, init = {}) {
  const timeout = AbortSignal.timeout(LINKED_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

async function parsePdfPageCount(bytes) {
  const document = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  return document.getPageCount();
}

async function inspectWebp(bytes) {
  const metadata = await sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: MAX_THUMBNAIL_PIXELS,
  }).metadata();
  const width = safeInteger(metadata.width);
  const height = safeInteger(metadata.height);
  const ratio = width && height ? width / height : null;
  return {
    valid:
      metadata.format === 'webp' &&
      width !== null &&
      width > 0 &&
      width <= MAX_THUMBNAIL_EDGE &&
      height !== null &&
      height > 0 &&
      height <= MAX_THUMBNAIL_EDGE &&
      ratio !== null &&
      Math.abs(ratio - 16 / 9) <= ASPECT_RATIO_TOLERANCE,
    format: metadata.format ?? null,
    width,
    height,
  };
}

async function readJson(filePath, errorCode) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new SafeCheckError(errorCode);
  }
}

async function loadLocalCatalog(snapshotRoot) {
  const catalog = await readJson(path.join(snapshotRoot, 'catalog.json'), 'LOCAL_CATALOG_INVALID');
  if (!catalog || !Array.isArray(catalog.courses) || catalog.courses.length !== 5) {
    throw new SafeCheckError('LOCAL_CATALOG_INVALID');
  }

  const courses = [];
  for (let index = 0; index < CANONICAL_SLUGS.length; index += 1) {
    const slug = CANONICAL_SLUGS[index];
    const displayOrder = index + 1;
    const catalogCourse = catalog.courses[index];
    if (
      !catalogCourse ||
      catalogCourse.slug !== slug ||
      catalogCourse.displayOrder !== displayOrder ||
      !SHA256_PATTERN.test(catalogCourse.dbContentHash ?? '') ||
      catalogCourse.contentHash !== catalogCourse.dbContentHash
    ) {
      throw new SafeCheckError('LOCAL_CATALOG_INVALID');
    }

    const courseRoot = path.join(snapshotRoot, slug);
    const course = await readJson(
      path.join(courseRoot, 'course.json'),
      'LOCAL_COURSE_SNAPSHOT_INVALID',
    );
    const presentation = course?.presentation;
    if (
      course?.slug !== slug ||
      course?.displayOrder !== displayOrder ||
      course?.dbContentHash !== catalogCourse.dbContentHash ||
      !presentation ||
      presentation.file !== 'presentation.pdf' ||
      presentation.thumbnail !== 'thumbnail.webp' ||
      presentation.mimeType !== 'application/pdf' ||
      presentation.aspectRatio !== '16:9' ||
      !SHA256_PATTERN.test(presentation.sha256 ?? '') ||
      !SHA256_PATTERN.test(presentation.thumbnailSha256 ?? '') ||
      safeInteger(presentation.byteSize) === null ||
      presentation.byteSize < 1 ||
      presentation.byteSize > MAX_PRESENTATION_BYTES ||
      safeInteger(presentation.pageCount) === null ||
      presentation.pageCount < 1 ||
      catalogCourse.presentationSha256 !== presentation.sha256 ||
      catalogCourse.pageCount !== presentation.pageCount
    ) {
      throw new SafeCheckError('LOCAL_COURSE_SNAPSHOT_INVALID');
    }

    let pdf;
    let thumbnail;
    try {
      [pdf, thumbnail] = await Promise.all([
        readFile(path.join(courseRoot, 'presentation.pdf')),
        readFile(path.join(courseRoot, 'thumbnail.webp')),
      ]);
    } catch {
      throw new SafeCheckError('LOCAL_PRESENTATION_ASSET_MISSING');
    }
    let localPageCount;
    let localThumbnail;
    try {
      [localPageCount, localThumbnail] = await Promise.all([
        parsePdfPageCount(pdf),
        inspectWebp(thumbnail),
      ]);
    } catch {
      throw new SafeCheckError('LOCAL_PRESENTATION_ASSET_INVALID');
    }
    if (
      pdf.byteLength !== presentation.byteSize ||
      sha256(pdf) !== presentation.sha256 ||
      localPageCount !== presentation.pageCount ||
      sha256(thumbnail) !== presentation.thumbnailSha256 ||
      !localThumbnail.valid
    ) {
      throw new SafeCheckError('LOCAL_PRESENTATION_ASSET_INVALID');
    }

    courses.push({
      slug,
      displayOrder,
      dbContentHash: course.dbContentHash,
      presentation: {
        sha256: presentation.sha256,
        byteSize: presentation.byteSize,
        pageCount: presentation.pageCount,
        thumbnailSha256: presentation.thumbnailSha256,
      },
    });
  }

  const catalogChecksum = sha256(
    Buffer.from(courses.map((course) => course.dbContentHash).join(','), 'utf8'),
  );
  if (catalog.catalogChecksum !== catalogChecksum) {
    throw new SafeCheckError('LOCAL_CATALOG_CHECKSUM_INVALID');
  }

  return {
    catalogChecksum,
    courses,
  };
}

function queryResult(result, errorCode) {
  if (result.error) throw new SafeCheckError(errorCode);
  return result.data;
}

/**
 * The production adapter deliberately exposes only SELECTs and Storage downloads.
 * Keeping it behind this narrow interface makes accidental production writes easy
 * to reject in review and straightforward to test without linked credentials.
 */
export function createSupabaseReadRepository(supabase) {
  return Object.freeze({
    async getBatch(batchId) {
      return queryResult(
        await supabase
          .from('course_catalog_batches')
          .select('id,status')
          .eq('id', batchId)
          .maybeSingle(),
        'BATCH_QUERY_FAILED',
      );
    },
    async listBatchItems(batchId) {
      return (
        queryResult(
          await supabase
            .from('course_catalog_batch_items')
            .select('test_id,display_order,expected_content_hash')
            .eq('batch_id', batchId)
            .order('display_order', { ascending: true }),
          'BATCH_ITEMS_QUERY_FAILED',
        ) ?? []
      );
    },
    async listDrafts(testIds) {
      if (testIds.length === 0) return [];
      return (
        queryResult(
          await supabase
            .from('course_drafts')
            .select('test_id,slug,display_order,content_hash,presentation_id')
            .in('test_id', testIds),
          'COURSE_DRAFTS_QUERY_FAILED',
        ) ?? []
      );
    },
    async listPresentations(presentationIds) {
      if (presentationIds.length === 0) return [];
      return (
        queryResult(
          await supabase
            .from('course_presentations')
            .select(
              'id,course_id,storage_bucket,storage_path,thumbnail_path,mime_type,byte_size,sha256,page_count,aspect_ratio,status',
            )
            .in('id', presentationIds),
          'PRESENTATIONS_QUERY_FAILED',
        ) ?? []
      );
    },
    async download(bucket, objectPath) {
      const result = await supabase.storage.from(bucket).download(objectPath);
      if (result.error || !result.data) throw new SafeCheckError('STORAGE_DOWNLOAD_FAILED');
      return Buffer.from(await result.data.arrayBuffer());
    },
  });
}

function addDrift(target, code) {
  if (!target.includes(code)) target.push(code);
}

function baseCourseResult(expected) {
  return {
    slug: expected.slug,
    displayOrder: expected.displayOrder,
    ok: false,
    checks: {
      batchItem: false,
      slugAndOrder: false,
      contentHash: false,
      presentationMetadata: false,
      pdf: false,
      thumbnail: false,
    },
    pdf: {
      expectedSha256: expected.presentation.sha256,
      actualSha256: null,
      expectedByteSize: expected.presentation.byteSize,
      actualByteSize: null,
      expectedPageCount: expected.presentation.pageCount,
      actualPageCount: null,
    },
    thumbnail: {
      expectedSha256: expected.presentation.thumbnailSha256,
      actualSha256: null,
      hashMatch: null,
      valid: false,
      format: null,
      width: null,
      height: null,
    },
    drift: [],
  };
}

export async function checkCatalogBatch({ batchId, repository, snapshotRoot }) {
  if (!UUID_PATTERN.test(batchId ?? '')) throw new SafeCheckError('INVALID_BATCH_ID');
  if (!repository || typeof repository.getBatch !== 'function') {
    throw new SafeCheckError('READ_REPOSITORY_INVALID');
  }
  const local = await loadLocalCatalog(snapshotRoot);
  const result = {
    ok: false,
    mode: 'linked-read-only',
    batchId,
    batchStatus: null,
    catalogChecksum: local.catalogChecksum,
    courseCount: 5,
    drift: [],
    warnings: [],
    courses: [],
  };

  const batch = await repository.getBatch(batchId);
  if (!batch || batch.id !== batchId) {
    addDrift(result.drift, 'BATCH_NOT_FOUND');
    result.courses = local.courses.map(baseCourseResult);
    return result;
  }
  result.batchStatus = batch.status ?? null;
  if (batch.status !== 'staging') addDrift(result.drift, 'BATCH_NOT_STAGING');

  const items = await repository.listBatchItems(batchId);
  if (items.length !== 5) addDrift(result.drift, 'BATCH_ITEM_COUNT_MISMATCH');
  const itemTestIds = items.map((item) => item.test_id).filter((id) => UUID_PATTERN.test(id ?? ''));
  if (new Set(itemTestIds).size !== 5) addDrift(result.drift, 'BATCH_ITEM_IDS_INVALID');
  const itemByOrder = new Map();
  for (const item of items) {
    const order = safeInteger(item.display_order);
    if (order === null || itemByOrder.has(order)) {
      addDrift(result.drift, 'BATCH_ITEM_ORDER_INVALID');
    } else {
      itemByOrder.set(order, item);
    }
  }

  const drafts = await repository.listDrafts([...new Set(itemTestIds)]);
  const draftByTestId = new Map(drafts.map((draft) => [draft.test_id, draft]));
  const presentationIds = [
    ...new Set(
      drafts.map((draft) => draft.presentation_id).filter((id) => UUID_PATTERN.test(id ?? '')),
    ),
  ];
  const presentations = await repository.listPresentations(presentationIds);
  const presentationById = new Map(
    presentations.map((presentation) => [presentation.id, presentation]),
  );

  for (const expected of local.courses) {
    const courseResult = baseCourseResult(expected);
    const item = itemByOrder.get(expected.displayOrder);
    if (!item || !UUID_PATTERN.test(item.test_id ?? '')) {
      addDrift(courseResult.drift, 'BATCH_ITEM_MISSING');
      result.courses.push(courseResult);
      continue;
    }
    courseResult.checks.batchItem = true;
    const draft = draftByTestId.get(item.test_id);
    if (!draft) {
      addDrift(courseResult.drift, 'COURSE_DRAFT_MISSING');
      result.courses.push(courseResult);
      continue;
    }
    if (
      draft.slug === expected.slug &&
      safeInteger(draft.display_order) === expected.displayOrder
    ) {
      courseResult.checks.slugAndOrder = true;
    } else {
      addDrift(courseResult.drift, 'COURSE_SLUG_OR_ORDER_MISMATCH');
    }
    if (
      item.expected_content_hash === expected.dbContentHash &&
      draft.content_hash === expected.dbContentHash &&
      item.expected_content_hash === draft.content_hash
    ) {
      courseResult.checks.contentHash = true;
    } else {
      addDrift(courseResult.drift, 'COURSE_CONTENT_HASH_MISMATCH');
    }

    const presentation = presentationById.get(draft.presentation_id);
    const immutablePdfPath = presentation
      ? `${item.test_id}/${presentation.id}/${expected.presentation.sha256}.pdf`
      : null;
    const immutableThumbnailPath = presentation
      ? `${item.test_id}/${presentation.id}/${expected.presentation.sha256}-thumb.webp`
      : null;
    const metadataMatches =
      presentation &&
      UUID_PATTERN.test(presentation.id ?? '') &&
      presentation.course_id === item.test_id &&
      presentation.status === 'ready' &&
      presentation.storage_bucket === PUBLIC_PRESENTATION_BUCKET &&
      presentation.mime_type === 'application/pdf' &&
      presentation.sha256 === expected.presentation.sha256 &&
      safeInteger(presentation.byte_size) === expected.presentation.byteSize &&
      safeInteger(presentation.page_count) === expected.presentation.pageCount &&
      presentation.aspect_ratio === '16:9' &&
      presentation.storage_path === immutablePdfPath &&
      presentation.thumbnail_path === immutableThumbnailPath;
    if (metadataMatches) {
      courseResult.checks.presentationMetadata = true;
    } else {
      addDrift(courseResult.drift, 'PRESENTATION_METADATA_MISMATCH');
    }

    if (metadataMatches) {
      try {
        const pdf = await repository.download(PUBLIC_PRESENTATION_BUCKET, immutablePdfPath);
        courseResult.pdf.actualSha256 = sha256(pdf);
        courseResult.pdf.actualByteSize = pdf.byteLength;
        try {
          courseResult.pdf.actualPageCount = await parsePdfPageCount(pdf);
        } catch {
          addDrift(courseResult.drift, 'PRESENTATION_PDF_INVALID');
        }
        if (
          courseResult.pdf.actualSha256 === expected.presentation.sha256 &&
          courseResult.pdf.actualByteSize === expected.presentation.byteSize &&
          courseResult.pdf.actualPageCount === expected.presentation.pageCount
        ) {
          courseResult.checks.pdf = true;
        } else {
          addDrift(courseResult.drift, 'PRESENTATION_PDF_DRIFT');
        }
      } catch {
        addDrift(courseResult.drift, 'PRESENTATION_PDF_DOWNLOAD_FAILED');
      }
    }

    if (metadataMatches) {
      try {
        const thumbnail = await repository.download(
          PUBLIC_PRESENTATION_BUCKET,
          immutableThumbnailPath,
        );
        courseResult.thumbnail.actualSha256 = sha256(thumbnail);
        courseResult.thumbnail.hashMatch =
          courseResult.thumbnail.actualSha256 === expected.presentation.thumbnailSha256;
        let inspected;
        try {
          inspected = await inspectWebp(thumbnail);
        } catch {
          inspected = { valid: false, format: null, width: null, height: null };
        }
        Object.assign(courseResult.thumbnail, inspected);
        if (inspected.valid) {
          courseResult.checks.thumbnail = true;
          if (!courseResult.thumbnail.hashMatch) {
            result.warnings.push({
              code: 'THUMBNAIL_SHA_MISMATCH',
              slug: expected.slug,
            });
          }
        } else {
          addDrift(courseResult.drift, 'PRESENTATION_THUMBNAIL_INVALID');
        }
      } catch {
        addDrift(courseResult.drift, 'PRESENTATION_THUMBNAIL_DOWNLOAD_FAILED');
      }
    }

    courseResult.ok = courseResult.drift.length === 0;
    result.courses.push(courseResult);
  }

  for (const course of result.courses) {
    for (const code of course.drift) addDrift(result.drift, `${course.slug}:${code}`);
  }
  result.ok = result.drift.length === 0;
  return result;
}

export function parseCliArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  let batchId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--batch-id') {
      if (batchId !== null || index + 1 >= argv.length) {
        throw new SafeCheckError('INVALID_BATCH_ID');
      }
      batchId = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--batch-id=')) {
      if (batchId !== null) throw new SafeCheckError('INVALID_BATCH_ID');
      batchId = argument.slice('--batch-id='.length);
      continue;
    }
    throw new SafeCheckError('INVALID_ARGUMENT');
  }
  if (!UUID_PATTERN.test(batchId ?? '')) throw new SafeCheckError('INVALID_BATCH_ID');
  return { help: false, batchId };
}

function linkedEnvironment(environment) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/u, '');
  const secret = environment.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new SafeCheckError('LINKED_SERVICE_ENV_MISSING');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeCheckError('LINKED_SERVICE_ENV_INVALID');
  }
  const hostMatch = parsed.hostname.match(/^([a-z0-9-]+)[.]supabase[.]co$/u);
  if (
    parsed.protocol !== 'https:' ||
    !hostMatch ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new SafeCheckError('LINKED_SERVICE_ENV_INVALID');
  }
  return { url: parsed.origin, secret, projectRef: hostMatch[1] };
}

export async function runCli({ argv = process.argv.slice(2), environment = process.env } = {}) {
  let targetProjectRef = null;
  try {
    const parsed = parseCliArguments(argv);
    if (parsed.help) {
      return {
        exitCode: 0,
        output: {
          ok: true,
          usage: 'npm run content:catalog-batch:check -- --batch-id <uuid>',
        },
      };
    }
    const linked = linkedEnvironment(environment);
    targetProjectRef = linked.projectRef;
    const supabase = createClient(linked.url, linked.secret, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch },
    });
    const output = await checkCatalogBatch({
      batchId: parsed.batchId,
      repository: createSupabaseReadRepository(supabase),
      snapshotRoot: path.join(process.cwd(), 'content', 'snapshots', 'courses'),
    });
    return {
      exitCode: output.ok ? 0 : 1,
      output: { ...output, targetProjectRef },
    };
  } catch (error) {
    return {
      exitCode: 1,
      output: {
        ok: false,
        mode: 'linked-read-only',
        ...(targetProjectRef ? { targetProjectRef } : {}),
        error: safeCode(error, 'CATALOG_BATCH_CHECK_FAILED'),
      },
    };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const execution = await runCli();
  console.log(JSON.stringify(execution.output));
  process.exitCode = execution.exitCode;
}
