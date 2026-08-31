import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  checkCatalogBatch,
  parseCliArguments,
  runCli,
} from '../../scripts/check-course-catalog-batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-course-catalog-batch.mjs');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const COURSE_FIXTURES = [
  ['plotnik', 1, 25],
  ['armaturshchik', 2, 31],
  ['lesomontazhnye-raboty', 3, 42],
  ['biot', 4, 59],
  ['pozharnaya-bezopasnost', 5, 41],
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function pdfWithPages(pageCount) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([320, 180]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function webp(color) {
  return sharp({
    create: { width: 320, height: 180, channels: 4, background: color },
  })
    .webp({ lossless: true })
    .toBuffer();
}

let fixture;

before(async () => {
  const snapshotRoot = await mkdtemp(path.join(tmpdir(), 'safetyhub-batch-check-'));
  const batchId = randomUUID();
  const batchItems = [];
  const drafts = [];
  const presentations = [];
  const storage = new Map();
  const catalogCourses = [];

  for (const [slug, displayOrder, pageCount] of COURSE_FIXTURES) {
    const testId = randomUUID();
    const presentationId = randomUUID();
    const pdf = await pdfWithPages(pageCount);
    const thumbnail = await webp({
      r: (displayOrder * 37) % 255,
      g: (displayOrder * 61) % 255,
      b: (displayOrder * 83) % 255,
      alpha: 1,
    });
    const pdfSha256 = sha256(pdf);
    const thumbnailSha256 = sha256(thumbnail);
    const dbContentHash = sha256(Buffer.from(`db:${slug}`, 'utf8'));
    const pdfPath = `${testId}/${presentationId}/${pdfSha256}.pdf`;
    const thumbnailPath = `${testId}/${presentationId}/${pdfSha256}-thumb.webp`;
    const courseRoot = path.join(snapshotRoot, slug);
    await mkdir(courseRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(courseRoot, 'presentation.pdf'), pdf),
      writeFile(path.join(courseRoot, 'thumbnail.webp'), thumbnail),
      writeFile(
        path.join(courseRoot, 'course.json'),
        `${JSON.stringify(
          {
            slug,
            displayOrder,
            dbContentHash,
            // This receipt intentionally differs and must never be used for batch parity.
            snapshotContentHash: sha256(Buffer.from(`snapshot:${slug}`, 'utf8')),
            presentation: {
              file: 'presentation.pdf',
              thumbnail: 'thumbnail.webp',
              mimeType: 'application/pdf',
              aspectRatio: '16:9',
              sha256: pdfSha256,
              thumbnailSha256,
              byteSize: pdf.byteLength,
              pageCount,
            },
          },
          null,
          2,
        )}\n`,
      ),
    ]);
    catalogCourses.push({
      slug,
      displayOrder,
      contentHash: dbContentHash,
      dbContentHash,
      snapshotContentHash: sha256(Buffer.from(`snapshot:${slug}`, 'utf8')),
      presentationSha256: pdfSha256,
      pageCount,
    });
    batchItems.push({
      test_id: testId,
      display_order: displayOrder,
      expected_content_hash: dbContentHash,
    });
    drafts.push({
      test_id: testId,
      slug,
      display_order: displayOrder,
      content_hash: dbContentHash,
      presentation_id: presentationId,
    });
    presentations.push({
      id: presentationId,
      course_id: testId,
      storage_bucket: 'course-presentations',
      storage_path: pdfPath,
      thumbnail_path: thumbnailPath,
      mime_type: 'application/pdf',
      byte_size: pdf.byteLength,
      sha256: pdfSha256,
      page_count: pageCount,
      aspect_ratio: '16:9',
      status: 'ready',
    });
    storage.set(`course-presentations/${pdfPath}`, pdf);
    storage.set(`course-presentations/${thumbnailPath}`, thumbnail);
  }

  const catalogChecksum = sha256(
    Buffer.from(catalogCourses.map((course) => course.dbContentHash).join(','), 'utf8'),
  );
  await writeFile(
    path.join(snapshotRoot, 'catalog.json'),
    `${JSON.stringify({ courses: catalogCourses, catalogChecksum }, null, 2)}\n`,
  );

  fixture = {
    snapshotRoot,
    batchId,
    batchItems,
    drafts,
    presentations,
    storage,
    catalogChecksum,
  };
});

after(async () => {
  if (fixture?.snapshotRoot) await rm(fixture.snapshotRoot, { recursive: true, force: true });
});

function repository({ storage = fixture.storage, mutate = () => undefined } = {}) {
  return {
    async getBatch(batchId) {
      mutate('getBatch');
      return batchId === fixture.batchId ? { id: batchId, status: 'staging' } : null;
    },
    async listBatchItems() {
      mutate('listBatchItems');
      return structuredClone(fixture.batchItems);
    },
    async listDrafts() {
      mutate('listDrafts');
      return structuredClone(fixture.drafts);
    },
    async listPresentations() {
      mutate('listPresentations');
      return structuredClone(fixture.presentations);
    },
    async download(bucket, objectPath) {
      mutate('download', bucket, objectPath);
      const value = storage.get(`${bucket}/${objectPath}`);
      if (!value) throw new Error('unavailable');
      return Buffer.from(value);
    },
  };
}

test('catalog batch checker validates the five staged courses against DB content hashes and bytes', async () => {
  const calls = [];
  const result = await checkCatalogBatch({
    batchId: fixture.batchId,
    repository: repository({ mutate: (call) => calls.push(call) }),
    snapshotRoot: fixture.snapshotRoot,
  });

  assert.equal(result.ok, true);
  assert.equal(result.batchStatus, 'staging');
  assert.equal(result.catalogChecksum, fixture.catalogChecksum);
  assert.deepEqual(
    result.courses.map(({ slug, displayOrder, ok }) => ({ slug, displayOrder, ok })),
    COURSE_FIXTURES.map(([slug, displayOrder]) => ({ slug, displayOrder, ok: true })),
  );
  assert.deepEqual(result.drift, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.filter((call) => call === 'download').length, 10);
  assert.doesNotMatch(JSON.stringify(result), /correctOption|answerKey|token|secret/iu);
});

test('a different but valid hosted WebP is reported without failing the batch', async () => {
  const replacement = await webp({ r: 1, g: 2, b: 3, alpha: 1 });
  const storage = new Map(fixture.storage);
  const first = fixture.presentations[0];
  storage.set(`course-presentations/${first.thumbnail_path}`, replacement);

  const result = await checkCatalogBatch({
    batchId: fixture.batchId,
    repository: repository({ storage }),
    snapshotRoot: fixture.snapshotRoot,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [{ code: 'THUMBNAIL_SHA_MISMATCH', slug: 'plotnik' }]);
  assert.equal(result.courses[0].thumbnail.valid, true);
  assert.equal(result.courses[0].thumbnail.hashMatch, false);
  assert.equal(result.courses[0].checks.thumbnail, true);
});

test('downloaded PDF drift fails closed even when database metadata still matches', async () => {
  const replacement = await pdfWithPages(1);
  const storage = new Map(fixture.storage);
  const first = fixture.presentations[0];
  storage.set(`course-presentations/${first.storage_path}`, replacement);

  const result = await checkCatalogBatch({
    batchId: fixture.batchId,
    repository: repository({ storage }),
    snapshotRoot: fixture.snapshotRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(result.courses[0].checks.presentationMetadata, true);
  assert.equal(result.courses[0].checks.pdf, false);
  assert.ok(result.courses[0].drift.includes('PRESENTATION_PDF_DRIFT'));
  assert.ok(result.drift.includes('plotnik:PRESENTATION_PDF_DRIFT'));
});

test('batch parity rejects snapshot receipt hashes in place of DB content hashes', async () => {
  const mismatchedItems = structuredClone(fixture.batchItems);
  mismatchedItems[0].expected_content_hash = sha256(Buffer.from('snapshot:plotnik', 'utf8'));
  const base = repository();
  const result = await checkCatalogBatch({
    batchId: fixture.batchId,
    repository: {
      ...base,
      async listBatchItems() {
        return mismatchedItems;
      },
    },
    snapshotRoot: fixture.snapshotRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(result.courses[0].checks.contentHash, false);
  assert.ok(result.courses[0].drift.includes('COURSE_CONTENT_HASH_MISMATCH'));
});

test('an invalid downloaded thumbnail fails even though hash mismatch alone is only a warning', async () => {
  const storage = new Map(fixture.storage);
  const first = fixture.presentations[0];
  storage.set(`course-presentations/${first.thumbnail_path}`, Buffer.from('not-a-webp'));

  const result = await checkCatalogBatch({
    batchId: fixture.batchId,
    repository: repository({ storage }),
    snapshotRoot: fixture.snapshotRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(result.courses[0].thumbnail.valid, false);
  assert.ok(result.courses[0].drift.includes('PRESENTATION_THUMBNAIL_INVALID'));
  assert.deepEqual(result.warnings, []);
});

test('unexpected presentation metadata fails without downloading from a foreign bucket', async () => {
  const presentations = structuredClone(fixture.presentations);
  presentations[0].storage_bucket = 'profile-avatars';
  const calls = [];
  const base = repository({
    mutate: (method, ...args) => calls.push([method, ...args]),
  });
  const result = await checkCatalogBatch({
    batchId: fixture.batchId,
    repository: {
      ...base,
      async listPresentations() {
        return presentations;
      },
    },
    snapshotRoot: fixture.snapshotRoot,
  });

  assert.equal(result.ok, false);
  assert.ok(result.courses[0].drift.includes('PRESENTATION_METADATA_MISMATCH'));
  assert.equal(
    calls.some(
      ([method, , objectPath]) =>
        method === 'download' && objectPath === fixture.presentations[0].storage_path,
    ),
    false,
  );
  assert.equal(calls.filter(([method]) => method === 'download').length, 8);
});

test('CLI contract requires one UUID and returns redacted config failures', async () => {
  assert.deepEqual(parseCliArguments(['--batch-id', fixture.batchId]), {
    help: false,
    batchId: fixture.batchId,
  });
  assert.throws(() => parseCliArguments(['--batch-id', 'not-a-uuid']), /INVALID_BATCH_ID/u);

  const execution = await runCli({
    argv: ['--batch-id', fixture.batchId],
    environment: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    },
  });
  assert.equal(execution.exitCode, 1);
  assert.deepEqual(execution.output, {
    ok: false,
    mode: 'linked-read-only',
    error: 'LINKED_SERVICE_ENV_MISSING',
  });

  const invalidOrigin = await runCli({
    argv: ['--batch-id', fixture.batchId],
    environment: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co/unexpected?target=other',
      SUPABASE_SECRET_KEY: 'never-printed-service-secret',
    },
  });
  assert.deepEqual(invalidOrigin.output, {
    ok: false,
    mode: 'linked-read-only',
    error: 'LINKED_SERVICE_ENV_INVALID',
  });
  assert.doesNotMatch(JSON.stringify(invalidOrigin), /never-printed/iu);
});

test('script and package expose a SELECT/download-only linked command', async () => {
  const [source, packageJson] = await Promise.all([
    readFile(SCRIPT_PATH, 'utf8'),
    readFile(PACKAGE_PATH, 'utf8').then(JSON.parse),
  ]);
  const repositorySource = source.slice(
    source.indexOf('export function createSupabaseReadRepository'),
    source.indexOf('function addDrift'),
  );
  assert.match(repositorySource, /[.]select\(/u);
  assert.match(repositorySource, /[.]download\(/u);
  assert.doesNotMatch(
    repositorySource,
    /[.](?:insert|update|delete|upsert|remove|upload|copy|move|rpc)\s*\(/u,
  );
  assert.deepEqual(
    [...repositorySource.matchAll(/[.]from\('([^']+)'\)/gu)].map((match) => match[1]).sort(),
    [
      'course_catalog_batch_items',
      'course_catalog_batches',
      'course_drafts',
      'course_presentations',
    ],
  );
  const coreSource = source.slice(
    source.indexOf('export async function checkCatalogBatch'),
    source.indexOf('export function parseCliArguments'),
  );
  assert.deepEqual(
    [
      ...new Set([...coreSource.matchAll(/repository[.]([a-zA-Z]+)\(/gu)].map((match) => match[1])),
    ].sort(),
    ['download', 'getBatch', 'listBatchItems', 'listDrafts', 'listPresentations'],
  );
  assert.equal(
    packageJson.scripts['content:catalog-batch:check'],
    'node --env-file-if-exists=.env.local scripts/check-course-catalog-batch.mjs',
  );
});
