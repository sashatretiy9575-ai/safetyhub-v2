import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

import { validateLocalizedPublishedSnapshot } from './content-localization/localized-published-snapshot.mjs';

const SNAPSHOT_ROOT = path.resolve('content', 'snapshots', 'courses');
const MEDIA_SNAPSHOT_ROOT = path.resolve('content', 'snapshots', 'media');
const LOCALIZATION_SNAPSHOT_ROOT = path.resolve('content', 'snapshots', 'localizations');
const PRESENTATION_BUCKET = 'course-presentations';

function decodeShellValue(rawValue) {
  const value = rawValue.trim().replace(/[;]$/u, '');
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function localEnvironment() {
  const cli = path.resolve('node_modules', 'supabase', 'dist', 'supabase.js');
  const result = spawnSync(process.execPath, [cli, 'status', '-o', 'env'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Local Supabase is not running. Start Docker and run `supabase start`.');
  }
  const values = {};
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^(API_URL|SERVICE_ROLE_KEY)=(.+)$/u);
    if (match) values[match[1]] = decodeShellValue(match[2]);
  }
  if (!values.API_URL || !values.SERVICE_ROLE_KEY) {
    throw new Error('Local Supabase status did not expose API credentials.');
  }
  return { url: values.API_URL, secret: values.SERVICE_ROLE_KEY };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

const { url, secret } = localEnvironment();
const supabase = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const catalog = await readJson(path.join(SNAPSHOT_ROOT, 'catalog.json'));
const mediaManifest = await readJson(path.join(MEDIA_SNAPSHOT_ROOT, 'manifest.json'));
let localizationManifest = null;
try {
  localizationManifest = await readJson(
    path.join(LOCALIZATION_SNAPSHOT_ROOT, 'manifest.json'),
  );
  await validateLocalizedPublishedSnapshot({
    snapshotRoot: LOCALIZATION_SNAPSHOT_ROOT,
    required: true,
  });
} catch (error) {
  if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
}
const results = [];
const localizedResults = [];
const mediaResults = [];

async function ensureObject(bucket, storagePath, bytes, contentType, expectedHash) {
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`${storagePath}: local snapshot hash mismatch.`);
  }

  const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, bytes, {
    cacheControl: '31536000, immutable',
    contentType,
    upsert: false,
  });
  if (!uploadError) return 'uploaded';
  if (!/already exists|duplicate/iu.test(uploadError.message)) {
    throw new Error(`${storagePath}: local Storage upload failed.`);
  }

  const { data, error: downloadError } = await supabase.storage.from(bucket).download(storagePath);
  if (downloadError || !data) {
    // Naming the underlying failure matters: an interrupted earlier run leaves a
    // row without a body, and 'could not be verified' alone reads like a hash
    // mismatch rather than a half-written object.
    throw new Error(
      `${storagePath}: existing object could not be read back (${downloadError?.message ?? 'no body returned'}).`,
    );
  }
  const existing = Buffer.from(await data.arrayBuffer());
  if (sha256(existing) !== expectedHash) {
    throw new Error(`${storagePath}: immutable path contains different bytes.`);
  }
  return 'verified';
}

for (const item of catalog.courses) {
  const courseDirectory = path.join(SNAPSHOT_ROOT, item.slug);
  const course = await readJson(path.join(courseDirectory, 'course.json'));
  const [pdf, thumbnail] = await Promise.all([
    readFile(path.join(courseDirectory, course.presentation.file)),
    readFile(path.join(courseDirectory, course.presentation.thumbnail)),
  ]);
  const pdfStatus = await ensureObject(
    PRESENTATION_BUCKET,
    course.presentation.storagePath,
    pdf,
    'application/pdf',
    course.presentation.sha256,
  );
  const thumbnailStatus = await ensureObject(
    PRESENTATION_BUCKET,
    course.presentation.thumbnailPath,
    thumbnail,
    'image/webp',
    course.presentation.thumbnailSha256,
  );
  results.push({ slug: course.slug, pdf: pdfStatus, thumbnail: thumbnailStatus });
}

for (const course of localizationManifest?.courses ?? []) {
  for (const localization of course.localizations) {
    if (localization.locale === 'ru') continue;
    const { presentation } = localization;
    const [pdf, thumbnail] = await Promise.all([
      readFile(path.join(LOCALIZATION_SNAPSHOT_ROOT, ...presentation.asset.pdfFile.split('/'))),
      readFile(
        path.join(
          LOCALIZATION_SNAPSHOT_ROOT,
          ...presentation.asset.thumbnailFile.split('/'),
        ),
      ),
    ]);
    const [pdfStatus, thumbnailStatus] = await Promise.all([
      ensureObject(
        PRESENTATION_BUCKET,
        presentation.storagePath,
        pdf,
        'application/pdf',
        presentation.sha256,
      ),
      ensureObject(
        PRESENTATION_BUCKET,
        presentation.thumbnailPath,
        thumbnail,
        'image/webp',
        presentation.asset.thumbnailSha256,
      ),
    ]);
    localizedResults.push({
      slugHash: sha256(Buffer.from(course.slug, 'utf8')),
      locale: localization.locale,
      pdf: pdfStatus,
      thumbnail: thumbnailStatus,
    });
  }
}

if (mediaManifest.schemaVersion !== 1 || mediaManifest.bucket !== 'content-media') {
  throw new Error('The content media snapshot manifest is invalid.');
}
for (const asset of mediaManifest.assets) {
  const bytes = await readFile(path.join(MEDIA_SNAPSHOT_ROOT, asset.file));
  if (bytes.length !== asset.byteSize) {
    throw new Error(`${asset.id}: local content media size mismatch.`);
  }
  const status = await ensureObject(
    mediaManifest.bucket,
    asset.storageKey,
    bytes,
    asset.mimeType,
    asset.sha256,
  );
  mediaResults.push({ id: asset.id, status });
}

console.log(JSON.stringify({
  ok: true,
  target: 'local',
  presentations: { bucket: PRESENTATION_BUCKET, results },
  localizedPresentations: { bucket: PRESENTATION_BUCKET, results: localizedResults },
  media: { bucket: mediaManifest.bucket, results: mediaResults },
}));
