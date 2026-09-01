/**
 * Content summary: builds the deterministic KK/EN visual-QA receipt for the
 * five localized SafetyHub course presentation pairs after every deck passes.
 *
 * Design description: the receipt preserves the template-first evidence chain
 * by binding each locale/deck to exactly one canonical content-addressed PPTX,
 * one PDF, its current text map, and equal source/rendered/page counts.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const canonicalLocales = ['kk', 'en', 'zh'];
const slugs = [
  'plotnik',
  'armaturshchik',
  'lesomontazhnye-raboty',
  'biot',
  'pozharnaya-bezopasnost',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function option(name) {
  const equalsPrefix = `${name}=`;
  const equalsValue = process.argv.find((value) => value.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const requestedLocales = option('--locales') ?? 'kk,en';
const requestedSet = requestedLocales === 'all'
  ? new Set(canonicalLocales)
  : new Set(requestedLocales.split(',').map((locale) => locale.trim()).filter(Boolean));
if (!requestedSet.size || [...requestedSet].some((locale) => !canonicalLocales.includes(locale))) {
  throw new Error(`LOCALES_INVALID:${requestedLocales}`);
}
const locales = canonicalLocales.filter((locale) => requestedSet.has(locale));
const localeFileKey = locales.length === canonicalLocales.length ? 'all' : locales.join('-');

function artifactPath(receiptArtifact, kind, extension) {
  const normalized = String(receiptArtifact?.path ?? '').replaceAll('\\', '/');
  const suffix = `/assets/${kind}/${receiptArtifact?.sha256}/presentation.${extension}`;
  if (!normalized.endsWith(suffix)) throw new Error(`ARTIFACT_PATH_NOT_CONTENT_ADDRESSED:${normalized}:${suffix}`);
  return path.join(repoRoot, normalized);
}

const presentations = [];
for (const locale of locales) {
  for (const slug of slugs) {
    const localeRoot = path.join(stagedRoot, 'presentations', slug, locale);
    const receiptPath = path.join(localeRoot, 'artifact-receipt.json');
    const mapPath = path.join(localeRoot, 'text-map.json');
    const [receiptBytes, mapBytes] = await Promise.all([
      fs.readFile(receiptPath),
      fs.readFile(mapPath),
    ]);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    const textMap = JSON.parse(mapBytes.toString('utf8'));
    if (receipt.locale !== locale || receipt.slug !== slug || textMap.locale !== locale || textMap.slug !== slug) {
      throw new Error(`ARTIFACT_RECEIPT_IDENTITY_MISMATCH:${locale}:${slug}`);
    }
    const mapSha256 = sha256(mapBytes);
    if (receipt.source?.textMapSha256 !== mapSha256 || receipt.qa?.presentationTextMapSha256 !== mapSha256) {
      throw new Error(`ARTIFACT_RECEIPT_MAP_STALE:${locale}:${slug}`);
    }
    const sourcePath = path.join(repoRoot, receipt.source.pptx);
    const pptxPath = artifactPath(receipt.pptx, 'pptx', 'pptx');
    const pdfPath = artifactPath(receipt.pdf, 'pdf', 'pdf');
    const [sourceBytes, pptxBytes, pdfBytes] = await Promise.all([
      fs.readFile(sourcePath),
      fs.readFile(pptxPath),
      fs.readFile(pdfPath),
    ]);
    if (sha256(sourceBytes) !== receipt.source.pptxSha256) throw new Error(`SOURCE_PPTX_HASH_MISMATCH:${locale}:${slug}`);
    if (sha256(pptxBytes) !== receipt.pptx.sha256 || pptxBytes.length !== receipt.pptx.byteSize) {
      throw new Error(`CANONICAL_PPTX_MISMATCH:${locale}:${slug}`);
    }
    if (sha256(pdfBytes) !== receipt.pdf.sha256 || pdfBytes.length !== receipt.pdf.byteSize) {
      throw new Error(`CANONICAL_PDF_MISMATCH:${locale}:${slug}`);
    }
    const counts = [
      receipt.pptx.slideCount,
      receipt.pdf.pageCount,
      receipt.qa.pptxRenderedSlideCount,
      receipt.qa.pdfRenderedPageCount,
      receipt.qa.pageTextLayerCount,
      receipt.qa.nonblankPageChecks,
    ];
    if (counts.some((count) => count !== textMap.slideCount)) {
      throw new Error(`ARTIFACT_RECEIPT_COUNT_MISMATCH:${locale}:${slug}:${counts.join(',')}:${textMap.slideCount}`);
    }
    if (
      receipt.qa.status !== 'passed'
      || receipt.qa.sourceGeometryVerified !== true
      || receipt.qa.sourceGeometryExactExceptApprovedLayoutOverrides !== true
      || !(receipt.qa.verifiedGeometryElementCount > 0)
      || !Number.isInteger(receipt.qa.approvedLayoutOverrideCount)
      || !Array.isArray(receipt.qa.approvedLayoutOverrides)
      || receipt.qa.approvedLayoutOverrides.length !== receipt.qa.approvedLayoutOverrideCount
      || receipt.qa.neighborGeometryUnchanged !== true
      || receipt.qa.newlyIntersectedNeighborCount !== 0
      || !(receipt.qa.masterLayoutTopology?.slideMasterCount > 0)
      || !(receipt.qa.masterLayoutTopology?.slideLayoutCount > 0)
      || receipt.qa.masterLayoutTopology?.slideRelationshipPartCount !== textMap.slideCount
      || receipt.qa.localizedTextMismatchCount !== 0
      || receipt.qa.missingGlyphSentinelCount !== 0
      || receipt.qa.templateTypographyRegressionCount !== 0
      || receipt.qa.canvasOverflowCount !== 0
      || receipt.qa.textFrameOverflowCount !== 0
    ) {
      throw new Error(`ARTIFACT_RECEIPT_QA_FAILED:${locale}:${slug}`);
    }
    presentations.push({
      locale,
      slug,
      textMapSha256: mapSha256,
      sourceSlideCount: textMap.slideCount,
      pptx: receipt.pptx,
      pdf: receipt.pdf,
      renderedSlideCount: receipt.qa.pptxRenderedSlideCount,
      renderedPageCount: receipt.qa.pdfRenderedPageCount,
      approvedLayoutOverrideCount: receipt.qa.approvedLayoutOverrideCount,
      layoutOverrideReceipt: receipt.qa.layoutOverrideReceipt,
      artifactReceipt: relativeToRepo(receiptPath),
      artifactReceiptSha256: sha256(receiptBytes),
    });
  }
}

const totalSlides = presentations.reduce((total, presentation) => total + presentation.sourceSlideCount, 0);
const output = {
  schemaVersion: 1,
  scope: `SafetyHub Stage 6 localized presentation artifacts (${locales.map((locale) => locale.toUpperCase()).join('/')})`,
  productionPublished: false,
  automatedReviewOnly: true,
  locales,
  localeCount: locales.length,
  sourceDeckCount: slugs.length,
  presentationCount: presentations.length,
  sourceSlideCount: totalSlides,
  pptxRenderedSlideCount: presentations.reduce((total, item) => total + item.renderedSlideCount, 0),
  pdfRenderedPageCount: presentations.reduce((total, item) => total + item.renderedPageCount, 0),
  canonicalArtifactContract: {
    pptxPerDeckLocale: 1,
    pdfPerDeckLocale: 1,
    contentAddressedParentsVerified: true,
    hashesAndByteSizesVerified: true,
    sourceRenderPageCountsEqual: true,
    sourceGeometryExactExceptApprovedLayoutOverrides: true,
    neighborGeometryUnchanged: true,
    newlyIntersectedNeighborCount: 0,
    approvedLayoutOverrideCount: presentations.reduce((total, item) => total + item.approvedLayoutOverrideCount, 0),
  },
  presentations,
  residualRisk: [
    'Translation and visual review are automated-only and have not received human linguistic, legal or design approval.',
    'Production upload/publication and hosted parity remain deferred to the controlled release stage.',
  ],
};
if (presentations.length !== locales.length * slugs.length || totalSlides !== 198 * locales.length) {
  throw new Error(`AGGREGATE_PRESENTATION_COUNT_MISMATCH:${presentations.length}:${totalSlides}`);
}

const outputPath = path.join(stagedRoot, 'qa', `presentation-visual-qa-receipt.${localeFileKey}.json`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true,
  output: relativeToRepo(outputPath),
  presentationCount: presentations.length,
  sourceSlideCount: totalSlides,
  pptxRenderedSlideCount: output.pptxRenderedSlideCount,
  pdfRenderedPageCount: output.pdfRenderedPageCount,
}));
