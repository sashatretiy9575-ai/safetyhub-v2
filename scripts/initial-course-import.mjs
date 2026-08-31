import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const APPROVED_CATALOG_HASH = '11b5486025cbb94c02ea0ed021ce8a8afc3f1e4c997c9cccbf5497e8fb42c026';
const APPROVED_CATALOG_CHECKSUM =
  '9d34b6b4f106b6886a540e0b67c2f7be27ffa6b1e3e4656013e6192ed39c228a';
const APPROVED_CATALOG_VERSION = '2026-08-25-new-five-course-catalog';
const STAGING_BUCKET = 'course-presentations-staging';
const PUBLISHED_BUCKET = 'course-presentations';
const REQUEST_TIMEOUT_MS = 45_000;

class InitialImportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'InitialImportError';
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function optionValue(argv, name, required = true) {
  const matches = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      matches.push(argv[index + 1]);
      index += 1;
    } else if (argv[index].startsWith(`${name}=`)) {
      matches.push(argv[index].slice(name.length + 1));
    }
  }
  if (matches.length > 1 || (required && (!matches[0] || matches[0].startsWith('--')))) {
    throw new InitialImportError(`INVALID_${name.slice(2).replaceAll('-', '_').toUpperCase()}`);
  }
  return matches[0] ?? null;
}

export function parseCliArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const known = new Set([
    '--project-ref',
    '--actor-id',
    '--catalog-hash',
    '--confirm',
    '--receipt',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (!known.has(name)) throw new InitialImportError('INVALID_ARGUMENT');
    if (!argument.includes('=')) index += 1;
  }
  const projectRef = optionValue(argv, '--project-ref');
  const actorId = optionValue(argv, '--actor-id');
  const catalogHash = optionValue(argv, '--catalog-hash');
  const confirmation = optionValue(argv, '--confirm');
  const receipt = optionValue(argv, '--receipt', false);
  if (!PROJECT_REF_PATTERN.test(projectRef)) throw new InitialImportError('INVALID_PROJECT_REF');
  if (!UUID_PATTERN.test(actorId)) throw new InitialImportError('INVALID_ACTOR_ID');
  if (catalogHash !== APPROVED_CATALOG_HASH) {
    throw new InitialImportError('UNAPPROVED_CATALOG_HASH');
  }
  if (confirmation !== `INITIAL-IMPORT:${projectRef}:${catalogHash}`) {
    throw new InitialImportError('INVALID_CONFIRMATION');
  }
  return {
    help: false,
    projectRef,
    actorId,
    catalogHash,
    confirmation,
    receiptPath: receipt
      ? path.resolve(receipt)
      : path.resolve('tmp', 'initial-import', `${projectRef}-${catalogHash}.json`),
  };
}

export function linkedEnvironment(environment, projectRef) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/u, '');
  const secret = environment.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new InitialImportError('LINKED_SERVICE_ENV_MISSING');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new InitialImportError('LINKED_SERVICE_ENV_INVALID');
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
    throw new InitialImportError('PROJECT_REF_MISMATCH');
  }
  return { url: parsed.origin, secret };
}

function boundedFetch(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function verifySnapshotGate(root) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'course-content', 'validate-snapshot.mjs'), '--initial-import'],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 2 * 60 * 1000 },
  );
  if (result.error || result.status !== 0) {
    throw new InitialImportError('INITIAL_IMPORT_SNAPSHOT_VALIDATION_FAILED');
  }
}

export async function loadApprovedSnapshot(root = process.cwd()) {
  verifySnapshotGate(root);
  const snapshotRoot = path.join(root, 'content', 'snapshots', 'courses');
  const catalog = await readJson(path.join(snapshotRoot, 'catalog.json'));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.catalogVersion !== APPROVED_CATALOG_VERSION ||
    catalog.catalogHash !== APPROVED_CATALOG_HASH ||
    catalog.catalogChecksum !== APPROVED_CATALOG_CHECKSUM ||
    !Array.isArray(catalog.courses) ||
    catalog.courses.length !== 5
  ) {
    throw new InitialImportError('INITIAL_IMPORT_CATALOG_NOT_APPROVED');
  }

  const courses = [];
  const assets = [];
  for (const catalogCourse of catalog.courses) {
    const courseRoot = path.join(snapshotRoot, catalogCourse.slug);
    const course = await readJson(path.join(courseRoot, 'course.json'));
    const [pdf, thumbnail] = await Promise.all([
      readFile(path.join(courseRoot, course.presentation.file)),
      readFile(path.join(courseRoot, course.presentation.thumbnail)),
    ]);
    if (
      course.id !== catalogCourse.id ||
      course.slug !== catalogCourse.slug ||
      course.dbContentHash !== catalogCourse.dbContentHash ||
      sha256(pdf) !== course.presentation.sha256 ||
      pdf.byteLength !== course.presentation.byteSize ||
      sha256(thumbnail) !== course.presentation.thumbnailSha256 ||
      !SHA256_PATTERN.test(course.presentation.sha256) ||
      !SHA256_PATTERN.test(course.presentation.thumbnailSha256)
    ) {
      throw new InitialImportError(`INITIAL_IMPORT_ASSET_INVALID:${catalogCourse.slug}`);
    }
    courses.push(course);
    assets.push({
      slug: course.slug,
      courseId: course.id,
      presentationId: course.presentation.id,
      pdf,
      thumbnail,
      pdfHash: course.presentation.sha256,
      thumbnailHash: course.presentation.thumbnailSha256,
      publishedPdfPath: course.presentation.storagePath,
      publishedThumbnailPath: course.presentation.thumbnailPath,
    });
  }
  return {
    payload: {
      schemaVersion: 1,
      catalogVersion: catalog.catalogVersion,
      catalogHash: catalog.catalogHash,
      courses,
    },
    assets,
  };
}

function createRepository(supabase) {
  async function rpc(name, values) {
    const { data, error } = await supabase.rpc(name, values);
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new InitialImportError(`RPC_FAILED:${name}`);
    }
    return data;
  }

  async function assertPrivateBucket(bucket) {
    const { data, error } = await supabase.storage.getBucket(bucket);
    if (error || !data || data.public !== false) {
      throw new InitialImportError(`PRIVATE_BUCKET_UNAVAILABLE:${bucket}`);
    }
  }

  async function ensureObject(bucket, objectPath, bytes, contentType, expectedHash, immutable) {
    if (sha256(bytes) !== expectedHash) throw new InitialImportError('LOCAL_ASSET_HASH_MISMATCH');
    const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, bytes, {
      upsert: false,
      contentType,
      cacheControl: immutable ? '31536000, immutable' : '0',
    });
    if (uploadError && !/already exists|duplicate/iu.test(uploadError.message)) {
      throw new InitialImportError(`STORAGE_UPLOAD_FAILED:${bucket}`);
    }
    const { data, error: downloadError } = await supabase.storage.from(bucket).download(objectPath);
    if (downloadError || !data) throw new InitialImportError(`STORAGE_VERIFY_FAILED:${bucket}`);
    const actual = Buffer.from(await data.arrayBuffer());
    if (sha256(actual) !== expectedHash) {
      throw new InitialImportError(`IMMUTABLE_OBJECT_CONFLICT:${bucket}`);
    }
    return uploadError ? 'verified' : 'uploaded';
  }

  async function removeObjects(bucket, paths) {
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) throw new InitialImportError(`STORAGE_CLEANUP_FAILED:${bucket}`);
  }
  return { rpc, assertPrivateBucket, ensureObject, removeObjects };
}

function stagingPaths(operationId, asset) {
  const prefix = `initial-import/${operationId}/${asset.courseId}/${asset.presentationId}`;
  return { pdf: `${prefix}/source.pdf`, thumbnail: `${prefix}/thumbnail.webp` };
}

function safeReceipt({ projectRef, catalogHash, activation, assetResults, completion }) {
  return {
    schemaVersion: 1,
    mode: 'initial-course-import',
    projectRef,
    operationId: activation.operationId,
    batchId: activation.batchId,
    status: completion.status,
    catalogHash,
    catalogChecksum: activation.catalogChecksum,
    published: activation.published,
    history: activation.history,
    assets: {
      presentationCount: assetResults.length,
      staged: assetResults.every((item) =>
        ['uploaded', 'verified', 'skipped'].includes(item.staging),
      ),
      publishedImmutable: assetResults.every((item) =>
        ['uploaded', 'verified'].includes(item.published),
      ),
      stagingCleaned: completion.status === 'completed',
    },
    completedAt: new Date().toISOString(),
  };
}

export async function executeInitialImport({
  options,
  environment = process.env,
  root = process.cwd(),
  repository,
}) {
  const snapshot = await loadApprovedSnapshot(root);
  let repo = repository;
  if (!repo) {
    const linked = linkedEnvironment(environment, options.projectRef);
    const supabase = createClient(linked.url, linked.secret, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch },
    });
    repo = createRepository(supabase);
  }

  await Promise.all([
    repo.assertPrivateBucket(STAGING_BUCKET),
    repo.assertPrivateBucket(PUBLISHED_BUCKET),
  ]);
  const begun = await repo.rpc('begin_initial_course_import', {
    p_actor_id: options.actorId,
    p_project_ref: options.projectRef,
    p_catalog_hash: options.catalogHash,
    p_confirmation: options.confirmation,
  });
  if (!UUID_PATTERN.test(begun.operationId ?? '')) {
    throw new InitialImportError('INITIAL_IMPORT_OPERATION_INVALID');
  }

  const assetResults = [];
  const needsStaging = begun.status === 'begun' || begun.status === 'staged';
  for (const asset of snapshot.assets) {
    const staged = stagingPaths(begun.operationId, asset);
    let staging = 'skipped';
    if (needsStaging) {
      const [pdfStatus, thumbnailStatus] = await Promise.all([
        repo.ensureObject(
          STAGING_BUCKET,
          staged.pdf,
          asset.pdf,
          'application/pdf',
          asset.pdfHash,
          false,
        ),
        repo.ensureObject(
          STAGING_BUCKET,
          staged.thumbnail,
          asset.thumbnail,
          'image/webp',
          asset.thumbnailHash,
          false,
        ),
      ]);
      staging =
        pdfStatus === 'uploaded' || thumbnailStatus === 'uploaded' ? 'uploaded' : 'verified';
    }
    assetResults.push({ slug: asset.slug, staging, published: 'pending' });
  }

  await repo.rpc('stage_initial_course_import', {
    p_operation_id: begun.operationId,
    p_catalog_hash: options.catalogHash,
    p_payload: snapshot.payload,
  });

  for (let index = 0; index < snapshot.assets.length; index += 1) {
    const asset = snapshot.assets[index];
    const [pdfStatus, thumbnailStatus] = await Promise.all([
      repo.ensureObject(
        PUBLISHED_BUCKET,
        asset.publishedPdfPath,
        asset.pdf,
        'application/pdf',
        asset.pdfHash,
        true,
      ),
      repo.ensureObject(
        PUBLISHED_BUCKET,
        asset.publishedThumbnailPath,
        asset.thumbnail,
        'image/webp',
        asset.thumbnailHash,
        true,
      ),
    ]);
    assetResults[index].published =
      pdfStatus === 'uploaded' || thumbnailStatus === 'uploaded' ? 'uploaded' : 'verified';
  }

  await repo.rpc('prepare_initial_course_import', {
    p_operation_id: begun.operationId,
    p_catalog_hash: options.catalogHash,
  });
  const activation = await repo.rpc('activate_initial_course_import', {
    p_operation_id: begun.operationId,
    p_catalog_hash: options.catalogHash,
    p_idempotency_key: deterministicUuid(`${begun.operationId}:${options.catalogHash}:activate`),
  });
  if (
    activation.catalogChecksum !== APPROVED_CATALOG_CHECKSUM ||
    activation.published?.courses !== 5 ||
    activation.published?.revisions !== 5 ||
    activation.published?.variants !== 15 ||
    activation.published?.questions !== 150 ||
    activation.published?.options !== 600
  ) {
    throw new InitialImportError('INITIAL_IMPORT_FINAL_RECEIPT_INVALID');
  }

  for (const asset of snapshot.assets) {
    const staged = stagingPaths(begun.operationId, asset);
    await repo.removeObjects(STAGING_BUCKET, [staged.pdf, staged.thumbnail]);
  }
  const completion = await repo.rpc('complete_initial_course_import', {
    p_operation_id: begun.operationId,
    p_catalog_hash: options.catalogHash,
  });
  if (completion.status !== 'completed') {
    throw new InitialImportError('INITIAL_IMPORT_CLEANUP_INCOMPLETE');
  }

  const receipt = safeReceipt({
    projectRef: options.projectRef,
    catalogHash: options.catalogHash,
    activation,
    assetResults,
    completion,
  });
  await mkdir(path.dirname(options.receiptPath), { recursive: true });
  await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(options.receiptPath, 'utf8'));
    if (
      existing.operationId !== receipt.operationId ||
      existing.catalogHash !== receipt.catalogHash ||
      existing.status !== 'completed'
    ) {
      throw new InitialImportError('INITIAL_IMPORT_RECEIPT_CONFLICT');
    }
  });
  return { receipt, receiptPath: options.receiptPath };
}

export async function runCli({ argv = process.argv.slice(2), environment = process.env } = {}) {
  try {
    const options = parseCliArguments(argv);
    if (options.help) {
      return {
        exitCode: 0,
        output: {
          ok: true,
          usage:
            'npm run content:initial-import -- --project-ref <ref> --actor-id <uuid> --catalog-hash <sha256> --confirm INITIAL-IMPORT:<ref>:<sha256>',
        },
      };
    }
    const result = await executeInitialImport({ options, environment });
    return {
      exitCode: 0,
      output: { ok: true, ...result.receipt, receiptPath: result.receiptPath },
    };
  } catch (error) {
    return {
      exitCode: 1,
      output: {
        ok: false,
        error: error instanceof InitialImportError ? error.message : 'INITIAL_IMPORT_FAILED',
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
