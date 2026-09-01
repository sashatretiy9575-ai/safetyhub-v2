/**
 * Archives the bounded presentation QA evidence needed after transient
 * render workspaces are removed. It never touches linked or production data.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const aggregateAuditPath = path.join(stagedRoot, 'qa', 'presentation-layout-audit.all.json');
const locales = ['kk', 'en', 'zh'];
const slugs = ['plotnik', 'armaturshchik', 'lesomontazhnye-raboty', 'biot', 'pozharnaya-bezopasnost'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

const aggregateAudit = await readJson(aggregateAuditPath);
assert(aggregateAudit.regressionCount === 0, 'ARCHIVE_LAYOUT_AUDIT_FAILED');
assert(aggregateAudit.scope?.deckLocaleCount === 15 && aggregateAudit.scope?.inspectedSlideCount === 594, 'ARCHIVE_LAYOUT_AUDIT_SCOPE');

let archivedOverrideReceiptCount = 0;
let rewrittenPresentationReceiptCount = 0;
for (const locale of locales) {
  for (const slug of slugs) {
    const localeRoot = path.join(stagedRoot, 'presentations', slug, locale);
    const pptxReceiptPath = path.join(localeRoot, 'pptx-receipt.json');
    const artifactReceiptPath = path.join(localeRoot, 'artifact-receipt.json');
    const [pptxReceipt, artifactReceipt] = await Promise.all([
      readJson(pptxReceiptPath),
      readJson(artifactReceiptPath),
    ]);
    assert(pptxReceipt.locale === locale && pptxReceipt.slug === slug, `ARCHIVE_PPTX_ID:${locale}:${slug}`);
    assert(artifactReceipt.locale === locale && artifactReceipt.slug === slug, `ARCHIVE_ARTIFACT_ID:${locale}:${slug}`);

    const wrappers = [pptxReceipt.qa?.layoutOverrideReceipt, artifactReceipt.qa?.layoutOverrideReceipt].filter(Boolean);
    if (wrappers.length) {
      assert(wrappers.length === 2, `ARCHIVE_OVERRIDE_WRAPPER_COUNT:${locale}:${slug}`);
      const [{ path: _path, sha256: expectedSha256, byteSize: expectedBytes, ...payload }] = wrappers;
      const payloadBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      assert(payloadBytes.length === expectedBytes, `ARCHIVE_OVERRIDE_BYTES:${locale}:${slug}`);
      assert(sha256(payloadBytes) === expectedSha256, `ARCHIVE_OVERRIDE_HASH:${locale}:${slug}`);
      assert(wrappers.every((wrapper) => wrapper.sha256 === expectedSha256 && wrapper.byteSize === expectedBytes), `ARCHIVE_OVERRIDE_WRAPPERS_DIFFER:${locale}:${slug}`);

      const canonicalPath = path.join(localeRoot, 'qa', 'layout-only-override-receipt.json');
      await writeJson(canonicalPath, payload);
      const canonicalRelative = relative(canonicalPath);
      for (const wrapper of wrappers) wrapper.path = canonicalRelative;
      archivedOverrideReceiptCount += 1;
    }

    artifactReceipt.qa.templateTypographyReport = relative(aggregateAuditPath);
    await Promise.all([
      writeJson(pptxReceiptPath, pptxReceipt),
      writeJson(artifactReceiptPath, artifactReceipt),
    ]);
    rewrittenPresentationReceiptCount += 1;
  }
}

console.log(JSON.stringify({
  ok: true,
  productionPublished: false,
  aggregateLayoutAudit: relative(aggregateAuditPath),
  archivedOverrideReceiptCount,
  rewrittenPresentationReceiptCount,
}));
