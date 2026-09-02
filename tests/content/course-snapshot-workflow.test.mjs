import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { validateAndRenderPresentation } from '../../scripts/course-content/presentation-pdf-qa.mjs';

const root = process.cwd();

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

test('canonical five-course snapshot passes the material and hash validator', () => {
  const output = execFileSync(
    process.execPath,
    [path.join(root, 'scripts/course-content/validate-snapshot.mjs'), '--initial-import'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const result = JSON.parse(output);
  assert.equal(result.valid, true);
  assert.deepEqual(result.totals, {
    courseCount: 5,
    presentationCount: 5,
    presentationPageCount: 198,
    variantCount: 15,
    questionCount: 150,
    optionCount: 600,
    correctAnswerCount: 150,
  });
});

test('linked content export is explicitly scoped away from operational personal data', async () => {
  const source = await readFile(path.join(root, 'scripts/content-sync-linked.mjs'), 'utf8');
  for (const forbidden of [
    'auth.users',
    'public.profiles',
    'test_attempts',
    'attestations',
    'certificates',
    'admin_audit_log',
    'legal_acceptances',
  ]) {
    assert.equal(source.includes(forbidden), false, `must not read ${forbidden}`);
  }
  assert.match(source, /test_revision_variant_answer_keys/u);
  assert.match(source, /course_presentations/u);
  assert.match(source, /article_revisions/u);
  assert.match(source, /content_assets/u);
  assert.match(source, /content-media/u);
});

test('linked content export preserves PostgreSQL calendar dates east of UTC', async () => {
  const source = await readFile(path.join(root, 'scripts/content-sync-linked.mjs'), 'utf8');
  const definition = source.match(/function asDate\(value\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(definition, 'asDate helper is missing');

  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `${definition}
const postgresDate = new Date(2026, 7, 21);
console.log(JSON.stringify({
  utcProjection: postgresDate.toISOString().slice(0, 10),
  calendarProjection: asDate(postgresDate),
  stringProjection: asDate('2026-08-21'),
}));`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Oral' },
      windowsHide: true,
    },
  );

  assert.deepEqual(JSON.parse(output), {
    utcProjection: '2026-08-20',
    calendarProjection: '2026-08-21',
    stringProjection: '2026-08-21',
  });
});

test('generated content keeps deterministic LF line endings on Windows and CI', async () => {
  const attributes = await readFile(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^content\/\*\*\/\*\.json text eol=lf$/mu);
  assert.match(attributes, /^supabase\/seed\.sql text eol=lf$/mu);
});

test('public article media snapshot has a deterministic hash and verified files', async () => {
  const mediaRoot = path.join(root, 'content', 'snapshots', 'media');
  const manifest = JSON.parse(await readFile(path.join(mediaRoot, 'manifest.json'), 'utf8'));
  const projection = {
    schemaVersion: manifest.schemaVersion,
    bucket: manifest.bucket,
    assets: manifest.assets,
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.bucket, 'content-media');
  assert.equal(manifest.manifestHash, canonicalHash(projection));
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(mediaRoot, asset.file));
    assert.equal(bytes.length, asset.byteSize);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
});

test('package scripts expose the documented snapshot lifecycle', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const command of [
    'content:pull:linked',
    'content:snapshot:validate',
    'content:seed:generate',
    'content:parity:check',
  ]) {
    assert.equal(typeof packageJson.scripts[command], 'string', `${command} is missing`);
  }
});

test('presentation QA derives page totals and renders every page without requiring a CTA', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-pdf-qa-'));
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
      const page = pdf.addPage([1600, 900]);
      page.drawRectangle({
        x: 0,
        y: 0,
        width: 1600,
        height: 900,
        color: pageNumber === 1 ? rgb(0.06, 0.2, 0.42) : rgb(0.12, 0.42, 0.24),
      });
      page.drawText(`Future course page ${pageNumber}`, {
        x: 120,
        y: 430,
        size: 52,
        font,
        color: rgb(1, 1, 1),
      });
    }
    const pdfBytes = await pdf.save({ useObjectStreams: false });
    const digest = createHash('sha256').update(pdfBytes).digest('hex');
    const { manifest } = await validateAndRenderPresentation({
      slug: 'future-course',
      pdfBytes,
      expectedByteSize: pdfBytes.byteLength,
      expectedPageCount: 2,
      expectedSha256: digest,
      qaRoot: temporaryRoot,
    });

    assert.equal(manifest.pageCount, 2);
    assert.equal(manifest.renderedPageCount, 2);
    assert.equal(manifest.finalPageCta, null);
    assert.equal(manifest.validation.automated.status, 'passed');
    assert.equal(manifest.validation.safety.status, 'passed');
    assert.equal(manifest.validation.visual.status, 'pending');
    assert.equal(manifest.validation.visual.contactSheetCount, 1);
    assert.equal(
      (await readdir(path.join(temporaryRoot, 'future-course', 'pages'))).length,
      2,
    );
    assert.equal(
      (await readdir(path.join(temporaryRoot, 'future-course', 'contact-sheets'))).length,
      1,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('presentation QA accepts a Node Buffer at the pdfjs boundary', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-pdf-qa-buffer-'));
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([1600, 900]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 1600,
      height: 900,
      color: rgb(0.06, 0.2, 0.42),
    });
    page.drawText('Node Buffer presentation QA', {
      x: 120,
      y: 430,
      size: 52,
      font,
      color: rgb(1, 1, 1),
    });
    const pdfBytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    const { manifest } = await validateAndRenderPresentation({
      slug: 'node-buffer-course',
      pdfBytes,
      expectedByteSize: pdfBytes.byteLength,
      expectedPageCount: 1,
      expectedSha256: createHash('sha256').update(pdfBytes).digest('hex'),
      qaRoot: temporaryRoot,
    });

    assert.equal(Buffer.isBuffer(pdfBytes), true);
    assert.equal(manifest.renderedPageCount, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('linked pull previews a staged transaction before canonical replacement', async () => {
  const source = await readFile(path.join(root, 'scripts/content-sync-linked.mjs'), 'utf8');
  const previewIndex = source.indexOf("mode: 'preview'");
  const replacementIndex = source.lastIndexOf('await applyWithExclusiveLock()');
  assert.ok(previewIndex >= 0, 'pull must emit a preview');
  assert.ok(replacementIndex > previewIndex, 'canonical replacement must follow the preview');
  assert.match(source, /content-sync-stage/u);
  assert.match(source, /approval-required/u);
  assert.match(source, /validateAndRenderPresentation/u);
  assert.doesNotMatch(source, /renderedPageCount:\s*0/u);
});

test('PDF renderer discovers presentations from manifests instead of the initial slug matrix', async () => {
  const source = await readFile(
    path.join(root, 'scripts/course-content/render-and-verify-pdfs.mjs'),
    'utf8',
  );
  assert.match(source, /catalog[.]courses/u);
  assert.match(source, /sourceManifest[.]presentations/u);
  assert.doesNotMatch(source, /\[['"]plotnik['"],\s*25\]/u);
  assert.doesNotMatch(source, /final PDF page does not contain/u);
});

test('seed generator supports isolated staged roots and output', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-seed-stage-'));
  const outputPath = path.join(temporaryRoot, 'seed.sql');
  try {
    execFileSync(
      process.execPath,
      [
        path.join(root, 'scripts/generate-content-seed.mjs'),
        '--articles-root',
        path.join(root, 'content', 'articles'),
        '--courses-root',
        path.join(root, 'content', 'snapshots', 'courses'),
        '--media-root',
        path.join(root, 'content', 'snapshots', 'media'),
        '--output',
        outputPath,
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(await readFile(outputPath, 'utf8'), await readFile(path.join(root, 'supabase', 'seed.sql'), 'utf8'));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
