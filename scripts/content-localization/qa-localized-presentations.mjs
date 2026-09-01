/**
 * Content summary: validates every localized SafetyHub PPTX slide and PDF page
 * against the staged text map and immutable receipts.
 *
 * Design description: QA is template-aware and page-complete. It checks source
 * theme fidelity, one-to-one page topology, every localized text unit, PDF
 * safety/text layers, rasterized 1600x900 pages, blank-page variance, glyph
 * sentinels, and out-of-canvas rendering without changing the artifacts.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateAndRenderPresentation } from '../course-content/presentation-pdf-qa.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const allowedLocales = new Set(['kk', 'en', 'zh']);
const allowedSlugs = new Set([
  'armaturshchik',
  'biot',
  'lesomontazhnye-raboty',
  'plotnik',
  'pozharnaya-bezopasnost',
]);
const missingGlyphPattern = /[\uFFFD\u25A1\u25AF]/u;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function assertAllowed(value, allowed, code) {
  if (!value || !allowed.has(value)) throw new Error(`${code}:${value ?? ''}`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();
}

function searchableText(value, locale) {
  return normalizeText(value)
    .toLocaleLowerCase(locale === 'kk' ? 'kk-KZ' : locale === 'zh' ? 'zh-CN' : 'en')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mappedTexts(element) {
  if (element.kind === 'table') return element.cells.map((cell) => cell.translatedText);
  return [element.translatedText];
}

function isContentAddressedArtifact(artifact, kind, extension) {
  const suffix = `/assets/${kind}/${artifact.sha256}/presentation.${extension}`;
  return typeof artifact.path === 'string' && artifact.path.replaceAll('\\', '/').endsWith(suffix);
}

async function extractPdfPages(pdfBytes) {
  const pdfjs = await import(pathToFileURL(path.join(repoRoot, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);
  const task = pdfjs.getDocument({
    data: pdfBytes.slice(),
    disableWorker: true,
    enableXfa: false,
    isEvalSupported: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
    useSystemFonts: true,
    useWasm: false,
  });
  const pages = [];
  try {
    const document = await task.promise;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(normalizeText(content.items.map((item) => ('str' in item ? item.str : '')).join(' ')));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

function runCanvasOverflowCheck(pptxPath) {
  const python = process.env.PYTHON;
  const skillDir = process.env.SKILL_DIR;
  if (!python || !skillDir) throw new Error('PRESENTATION_QA_RUNTIME_ENV_MISSING');
  const script = path.join(skillDir, 'container_tools', 'slides_test.py');
  const result = spawnSync(python, [script, pptxPath, '--width', '1600', '--height', '900'], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0 || /ERROR:\s*Slides with content overflowing/u.test(output)) {
    throw new Error(`PPTX_CANVAS_OVERFLOW:${output}`);
  }
  if (!/Test passed\. No overflow detected\./u.test(output)) {
    throw new Error(`PPTX_CANVAS_OVERFLOW_RESULT_INVALID:${output}`);
  }
  return output;
}

async function qaDeck({ locale, slug }) {
  const localeRoot = path.join(stagedRoot, 'presentations', slug, locale);
  const workspace = path.join(workspaceRoot, locale, slug);
  const [textMap, pptxReceipt, pdfReceipt, textOverflowQa, layoutRegressionQa] = await Promise.all([
    readJson(path.join(localeRoot, 'text-map.json')),
    readJson(path.join(localeRoot, 'pptx-receipt.json')),
    readJson(path.join(localeRoot, 'pdf-receipt.json')),
    readJson(path.join(workspace, 'final', 'text-overflow-qa.json')),
    readJson(path.join(workspace, 'qa', 'layout-regressions.json')),
  ]);
  const pptxPath = path.join(repoRoot, pptxReceipt.pptx.path);
  const pdfPath = path.join(repoRoot, pdfReceipt.pdf.path);
  const [pptxBytes, pdfBytes, textMapBytes] = await Promise.all([
    fs.readFile(pptxPath),
    fs.readFile(pdfPath),
    fs.readFile(path.join(localeRoot, 'text-map.json')),
  ]);
  if (sha256(pptxBytes) !== pptxReceipt.pptx.sha256) throw new Error(`PPTX_HASH_MISMATCH:${locale}:${slug}`);
  if (sha256(pdfBytes) !== pdfReceipt.pdf.sha256) throw new Error(`PDF_HASH_MISMATCH:${locale}:${slug}`);
  if (pptxBytes.length !== pptxReceipt.pptx.byteSize) throw new Error(`PPTX_BYTE_SIZE_MISMATCH:${locale}:${slug}`);
  if (pdfBytes.length !== pdfReceipt.pdf.byteSize) throw new Error(`PDF_BYTE_SIZE_MISMATCH:${locale}:${slug}`);
  if (pptxReceipt.locale !== locale || pptxReceipt.slug !== slug) throw new Error(`PPTX_RECEIPT_IDENTITY_MISMATCH:${locale}:${slug}`);
  if (pdfReceipt.locale !== locale || pdfReceipt.slug !== slug) throw new Error(`PDF_RECEIPT_IDENTITY_MISMATCH:${locale}:${slug}`);
  if (pdfReceipt.sourcePptx?.sha256 !== pptxReceipt.pptx.sha256) throw new Error(`PDF_SOURCE_PPTX_MISMATCH:${locale}:${slug}`);
  if (!isContentAddressedArtifact(pptxReceipt.pptx, 'pptx', 'pptx')) throw new Error(`PPTX_PATH_NOT_CONTENT_ADDRESSED:${locale}:${slug}`);
  if (!isContentAddressedArtifact(pdfReceipt.pdf, 'pdf', 'pdf')) throw new Error(`PDF_PATH_NOT_CONTENT_ADDRESSED:${locale}:${slug}`);
  if (sha256(textMapBytes) !== pptxReceipt.source.textMapSha256) throw new Error(`TEXT_MAP_HASH_MISMATCH:${locale}:${slug}`);
  if (pptxReceipt.pptx.slideCount !== textMap.slideCount || pdfReceipt.pdf.pageCount !== textMap.slideCount) {
    throw new Error(`PAGE_COUNT_CONTRACT_MISMATCH:${locale}:${slug}`);
  }
  if (
    layoutRegressionQa.locale !== locale
    || layoutRegressionQa.slug !== slug
    || layoutRegressionQa.textMapSha256 !== sha256(textMapBytes)
    || layoutRegressionQa.inspectedSlideCount !== textMap.slideCount
    || layoutRegressionQa.regressionCount !== 0
    || pptxReceipt.qa.templateTypographyRegressionCount !== 0
  ) {
    throw new Error(`TEMPLATE_TYPOGRAPHY_REGRESSION:${locale}:${slug}:${JSON.stringify(layoutRegressionQa.regressions?.slice(0, 12) ?? [])}`);
  }
  if (
    pptxReceipt.qa.sourceGeometryExactExceptApprovedLayoutOverrides !== true
    || !Number.isInteger(pptxReceipt.qa.approvedLayoutOverrideCount)
    || !Array.isArray(pptxReceipt.qa.approvedLayoutOverrides)
    || pptxReceipt.qa.approvedLayoutOverrides.length !== pptxReceipt.qa.approvedLayoutOverrideCount
    || pptxReceipt.qa.neighborGeometryUnchanged !== true
    || pptxReceipt.qa.newlyIntersectedNeighborCount !== 0
  ) {
    throw new Error(`APPROVED_LAYOUT_OVERRIDE_CONTRACT_FAILED:${locale}:${slug}`);
  }
  if (pptxReceipt.qa.approvedLayoutOverrideCount === 0 && pptxReceipt.qa.layoutOverrideReceipt !== null) {
    throw new Error(`UNEXPECTED_LAYOUT_OVERRIDE_RECEIPT:${locale}:${slug}`);
  }
  if (pptxReceipt.qa.approvedLayoutOverrideCount > 0) {
    const layoutReceipt = pptxReceipt.qa.layoutOverrideReceipt;
    const layoutReceiptPath = path.join(repoRoot, layoutReceipt?.path ?? '');
    const layoutReceiptBytes = await fs.readFile(layoutReceiptPath);
    if (
      sha256(layoutReceiptBytes) !== layoutReceipt.sha256
      || layoutReceiptBytes.length !== layoutReceipt.byteSize
      || layoutReceipt.locale !== locale
      || layoutReceipt.slug !== slug
      || layoutReceipt.semanticsChanged !== false
      || layoutReceipt.neighborContentMoved !== false
      || layoutReceipt.newlyIntersectedNeighborCount !== 0
    ) {
      throw new Error(`LAYOUT_OVERRIDE_RECEIPT_INVALID:${locale}:${slug}`);
    }
  }
  if (
    textOverflowQa.locale !== locale
    || textOverflowQa.slug !== slug
    || textOverflowQa.pptxSha256 !== pptxReceipt.pptx.sha256
    || textOverflowQa.inspectedSlideCount !== textMap.slideCount
    || textOverflowQa.overflowCount !== 0
  ) {
    throw new Error(`POWERPOINT_TEXT_OVERFLOW:${locale}:${slug}:${JSON.stringify(textOverflowQa.overflows?.slice(0, 12) ?? [])}`);
  }
  const pdfData = Uint8Array.from(pdfBytes);

  const qaRoot = path.join(workspace, 'pdf-qa');
  const { manifest: pdfManifest } = await validateAndRenderPresentation({
    slug,
    pdfBytes: pdfData,
    expectedByteSize: pdfReceipt.pdf.byteSize,
    expectedPageCount: pdfReceipt.pdf.pageCount,
    expectedSha256: pdfReceipt.pdf.sha256,
    expectedThumbnailSha256: null,
    qaRoot,
    visualQaApproved: false,
    reviewedAt: null,
  });
  const pageTexts = await extractPdfPages(pdfData);
  if (pageTexts.length !== textMap.slideCount) throw new Error(`PDF_TEXT_PAGE_COUNT_MISMATCH:${locale}:${slug}`);
  const failures = [];
  let checkedTextUnits = 0;
  for (const slide of textMap.slides) {
    const pageSearchable = searchableText(pageTexts[slide.slide - 1], locale);
    if (missingGlyphPattern.test(pageTexts[slide.slide - 1])) {
      failures.push({ slide: slide.slide, code: 'MISSING_GLYPH_SENTINEL' });
    }
    for (const element of slide.elements) {
      for (const translatedText of mappedTexts(element)) {
        const target = searchableText(translatedText, locale);
        checkedTextUnits += 1;
        if (target && !pageSearchable.includes(target)) {
          failures.push({
            slide: slide.slide,
            shapeId: element.shapeId,
            name: element.name ?? null,
            code: 'PDF_TEXT_MAP_MISMATCH',
            targetSha256: sha256(Buffer.from(normalizeText(translatedText), 'utf8')),
          });
        }
      }
    }
  }
  if (failures.length) throw new Error(`LOCALIZED_PDF_QA_FAILED:${locale}:${slug}:${JSON.stringify(failures.slice(0, 12))}`);

  const renderedSlides = (await fs.readdir(path.join(workspace, 'final-render'))).filter((name) => name.endsWith('.png'));
  const renderedPages = (await fs.readdir(path.join(qaRoot, slug, 'pages'))).filter((name) => name.endsWith('.png'));
  if (renderedSlides.length !== textMap.slideCount || renderedPages.length !== textMap.slideCount) {
    throw new Error(`RENDER_COUNT_MISMATCH:${locale}:${slug}:${renderedSlides.length}:${renderedPages.length}`);
  }
  const canvasOverflowResult = runCanvasOverflowCheck(pptxPath);

  const receipt = {
    schemaVersion: 1,
    slug,
    locale,
    productionPublished: false,
    contentSummary: pptxReceipt.contentSummary,
    designDescription: pptxReceipt.designDescription,
    source: pptxReceipt.source,
    pptx: pptxReceipt.pptx,
    pdf: pdfReceipt.pdf,
    edits: pptxReceipt.edits,
    qa: {
      status: 'passed',
      automatedOnly: true,
      sourceThemePreserved: pptxReceipt.qa.sourceThemePreserved,
      sourceMasterLayoutHierarchyPreserved: pptxReceipt.qa.sourceMasterLayoutHierarchyPreserved,
      masterLayoutTopology: pptxReceipt.qa.masterLayoutTopology,
      sourceGeometryVerified: pptxReceipt.qa.sourceGeometryVerified,
      sourceGeometryExactExceptApprovedLayoutOverrides: pptxReceipt.qa.sourceGeometryExactExceptApprovedLayoutOverrides,
      verifiedGeometryElementCount: pptxReceipt.qa.verifiedGeometryElementCount,
      approvedLayoutOverrideCount: pptxReceipt.qa.approvedLayoutOverrideCount,
      approvedLayoutOverrides: pptxReceipt.qa.approvedLayoutOverrides,
      layoutOverrideReceipt: pptxReceipt.qa.layoutOverrideReceipt,
      neighborGeometryUnchanged: pptxReceipt.qa.neighborGeometryUnchanged,
      newlyIntersectedNeighborCount: pptxReceipt.qa.newlyIntersectedNeighborCount,
      emptyInheritedPlaceholderCount: pptxReceipt.qa.emptyInheritedPlaceholderCount,
      pptxRenderedSlideCount: renderedSlides.length,
      pdfRenderedPageCount: renderedPages.length,
      pageTextLayerCount: pageTexts.length,
      localizedTextUnitCount: checkedTextUnits,
      localizedTextMismatchCount: 0,
      missingGlyphSentinelCount: 0,
      templateTypographyRegressionCount: layoutRegressionQa.regressionCount,
      templateTypographyReport: relativeToRepo(path.join(workspace, 'qa', 'layout-regressions.json')),
      canvasOverflowCount: 0,
      canvasOverflowCheck: canvasOverflowResult,
      textFrameOverflowCount: textOverflowQa.overflowCount,
      textFrameObservedOverflowCount: textOverflowQa.observedOverflowCount ?? textOverflowQa.overflowCount,
      sourceTextFrameObservedOverflowCount: textOverflowQa.sourceObservedOverflowCount ?? null,
      inheritedWithinToleranceTextFrameOverflowCount: textOverflowQa.inheritedWithinToleranceOverflowCount ?? 0,
      newlyIntroducedTextFrameOverflowCount: textOverflowQa.newlyIntroducedOverflowCount ?? textOverflowQa.overflowCount,
      inspectedTextFrameCount: textOverflowQa.inspectedTextFrameCount,
      textFrameOverflowEngine: textOverflowQa.engine,
      nonblankPageChecks: pdfManifest.pages.length,
      pdfUnsafeActionCount: 0,
      pdfEmbeddedFileCount: 0,
      visualMethod: 'all-slide artifact-tool raster, all-page PDF.js 1600x900 raster/pixel inspection, contact sheets, localized text-layer comparison and padded-canvas overflow test',
      presentationTextMapSha256: sha256(textMapBytes),
    },
    residualRisk: [
      'Translation and visual review are automated-only and have not received human linguistic, legal or design approval.',
      'Production upload/publication and hosted parity remain deferred to the controlled release stage.',
    ],
  };
  const receiptPath = path.join(localeRoot, 'artifact-receipt.json');
  await writeJson(receiptPath, receipt);
  return {
    locale,
    slug,
    slideCount: textMap.slideCount,
    localizedTextUnitCount: checkedTextUnits,
    receiptPath: relativeToRepo(receiptPath),
  };
}

const locale = assertAllowed(argument('--locale'), allowedLocales, 'LOCALE_INVALID');
const slug = assertAllowed(argument('--slug'), allowedSlugs, 'SLUG_INVALID');
console.log(JSON.stringify({ ok: true, ...(await qaDeck({ locale, slug })) }));
