import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from '@napi-rs/canvas';
import sharp from 'sharp';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 200;
const RENDER_WIDTH = 1600;
const RENDER_HEIGHT = 900;
const CONTACT_COLUMNS = 4;
const CONTACT_ROWS = 3;
const CONTACT_PAGE_WIDTH = 384;
const CONTACT_PAGE_HEIGHT = 216;
const CONTACT_CELL_HEIGHT = 250;
const CTA_PATTERN = /Нажмите\s+[«"]?Начать тест[»"]?/iu;

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  return value.replace(/[\s\u00a0]+/gu, ' ').trim();
}

function hasEntries(value) {
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function mapValue(value, key) {
  if (value instanceof Map) return value.get(key);
  return value && typeof value === 'object' ? value[key] : undefined;
}

function unsafePdfToken(bytes) {
  const source = new TextDecoder('latin1').decode(bytes);
  if (/\/Encrypt\b/u.test(source)) return 'encrypted';
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFiles?|Filespec|EF)\b/u.test(source)) return 'unsafe';
  return null;
}

async function writeContactSheets(pagePngs, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const contactSheetCount = Math.ceil(pagePngs.length / (CONTACT_COLUMNS * CONTACT_ROWS));
  for (let sheetIndex = 0; sheetIndex < contactSheetCount; sheetIndex += 1) {
    const first = sheetIndex * CONTACT_COLUMNS * CONTACT_ROWS;
    const group = pagePngs.slice(first, first + CONTACT_COLUMNS * CONTACT_ROWS);
    const canvas = createCanvas(
      CONTACT_COLUMNS * CONTACT_PAGE_WIDTH,
      CONTACT_ROWS * CONTACT_CELL_HEIGHT,
    );
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111827';
    context.font = 'bold 18px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let index = 0; index < group.length; index += 1) {
      const page = group[index];
      const column = index % CONTACT_COLUMNS;
      const row = Math.floor(index / CONTACT_COLUMNS);
      const x = column * CONTACT_PAGE_WIDTH;
      const y = row * CONTACT_CELL_HEIGHT;
      const image = await loadImage(await readFile(page.path));
      context.drawImage(image, x, y, CONTACT_PAGE_WIDTH, CONTACT_PAGE_HEIGHT);
      context.fillText(
        `Page ${page.pageNumber}`,
        x + CONTACT_PAGE_WIDTH / 2,
        y + CONTACT_PAGE_HEIGHT + (CONTACT_CELL_HEIGHT - CONTACT_PAGE_HEIGHT) / 2,
      );
    }
    await writeFile(
      path.join(outputDirectory, `contact-sheet-${String(sheetIndex + 1).padStart(3, '0')}.png`),
      canvas.toBuffer('image/png'),
    );
  }
  return contactSheetCount;
}

/**
 * Validate one canonical learner PDF, render every page, and create a complete
 * snapshot QA receipt. The caller controls only the expected immutable
 * metadata; page count, page geometry, text and unsafe actions are independently
 * derived from the bytes.
 */
export async function validateAndRenderPresentation({
  slug,
  pdfBytes,
  thumbnailBytes = null,
  expectedByteSize,
  expectedPageCount,
  expectedSha256,
  expectedThumbnailSha256,
  qaRoot,
  visualQaApproved = false,
  reviewedAt = null,
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error('Invalid presentation slug.');
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.byteLength < 5 || pdfBytes.byteLength > MAX_BYTES) {
    throw new Error(`${slug}: PDF size is outside 1..${MAX_BYTES}.`);
  }
  if (Buffer.from(pdfBytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new Error(`${slug}: invalid PDF signature.`);
  }
  const digest = sha256(pdfBytes);
  if (digest !== expectedSha256 || pdfBytes.byteLength !== expectedByteSize) {
    throw new Error(`${slug}: PDF hash or byte size differs from published metadata.`);
  }
  if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1 || expectedPageCount > MAX_PAGES) {
    throw new Error(`${slug}: published page count is outside 1..${MAX_PAGES}.`);
  }
  if (
    visualQaApproved &&
    (typeof reviewedAt !== 'string' || !Number.isFinite(Date.parse(reviewedAt)))
  ) {
    throw new Error(`${slug}: visual approval requires a valid review timestamp.`);
  }
  const rawSafety = unsafePdfToken(pdfBytes);
  if (rawSafety === 'encrypted') throw new Error(`${slug}: encrypted PDFs are not allowed.`);
  if (rawSafety === 'unsafe') throw new Error(`${slug}: unsafe PDF action or attachment token found.`);

  const courseQaRoot = path.join(qaRoot, slug);
  const pagesRoot = path.join(courseQaRoot, 'pages');
  const contactsRoot = path.join(courseQaRoot, 'contact-sheets');
  await rm(courseQaRoot, { recursive: true, force: true });
  await mkdir(pagesRoot, { recursive: true });
  await writeFile(path.join(courseQaRoot, 'presentation.pdf'), pdfBytes);

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: pdfBytes.slice(),
    disableWorker: true,
    enableXfa: false,
    isEvalSupported: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: RENDER_WIDTH * RENDER_HEIGHT * 4,
    stopAtErrors: true,
    useSystemFonts: true,
    useWasm: false,
  });

  let firstPagePng = null;
  let finalPageText = '';
  const pageResults = [];
  const pagePngs = [];
  try {
    const document = await task.promise;
    if (document.numPages !== expectedPageCount) {
      throw new Error(`${slug}: expected ${expectedPageCount} pages, got ${document.numPages}.`);
    }
    const [attachments, documentJavaScript, openAction] = await Promise.all([
      document.getAttachments(),
      document.getJSActions(),
      document.getOpenAction(),
    ]);
    if (
      hasEntries(attachments) ||
      hasEntries(documentJavaScript) ||
      mapValue(openAction, 'action') !== undefined
    ) {
      throw new Error(`${slug}: unsafe document-level PDF feature found.`);
    }

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const ratio = baseViewport.width / baseViewport.height;
      if (
        !Number.isFinite(ratio) ||
        baseViewport.width <= 0 ||
        baseViewport.height <= 0 ||
        Math.abs(ratio - 16 / 9) > 0.002
      ) {
        throw new Error(`${slug} page ${pageNumber}: page is not 16:9.`);
      }
      const [pageJavaScript, annotations] = await Promise.all([
        page.getJSActions(),
        page.getAnnotations({ intent: 'any' }),
      ]);
      const unsafeAnnotation = annotations.some(
        (annotation) =>
          annotation.annotationType === pdfjs.AnnotationType.FILEATTACHMENT ||
          annotation.hasJSActions === true ||
          annotation.attachment !== undefined ||
          annotation.file !== undefined ||
          String(annotation.action ?? '').toLowerCase() === 'launch',
      );
      if (hasEntries(pageJavaScript) || unsafeAnnotation) {
        throw new Error(`${slug} page ${pageNumber}: unsafe page action or attachment found.`);
      }

      const scale = RENDER_WIDTH / baseViewport.width;
      const viewport = page.getViewport({ scale });
      if (
        Math.round(viewport.width) !== RENDER_WIDTH ||
        Math.round(viewport.height) !== RENDER_HEIGHT
      ) {
        throw new Error(
          `${slug} page ${pageNumber}: expected ${RENDER_WIDTH}x${RENDER_HEIGHT} render.`,
        );
      }
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport }).promise;
      const png = canvas.toBuffer('image/png');
      const stats = await sharp(png).stats();
      const variance = stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0);
      if (variance < 0.5) throw new Error(`${slug} page ${pageNumber}: rendered page appears blank.`);

      const textContent = await page.getTextContent();
      const text = normalizeText(
        textContent.items.map((item) => ('str' in item ? item.str : '')).join(' '),
      );
      if (!text) throw new Error(`${slug} page ${pageNumber}: accessible text layer is empty.`);
      if (pageNumber === document.numPages) finalPageText = text;
      if (pageNumber === 1) firstPagePng = png;
      const pagePath = path.join(pagesRoot, `page-${String(pageNumber).padStart(3, '0')}.png`);
      await writeFile(pagePath, png);
      pagePngs.push({ pageNumber, path: pagePath });
      pageResults.push({
        pageNumber,
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        pngSha256: sha256(png),
        textSha256: sha256(Buffer.from(text, 'utf8')),
        textCharacters: text.length,
        luminanceMean: Number(stats.channels[0].mean.toFixed(3)),
        colorStdevTotal: Number(variance.toFixed(3)),
      });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  if (!firstPagePng) throw new Error(`${slug}: first page was not rendered.`);
  const verifiedThumbnail = thumbnailBytes
    ? Buffer.from(thumbnailBytes)
    : await sharp(firstPagePng)
        .resize(800, 450, { fit: 'cover' })
        .webp({ quality: 84, smartSubsample: true })
        .toBuffer();
  const thumbnail = await sharp(verifiedThumbnail, {
    failOn: 'warning',
    limitInputPixels: 4_000_000,
  }).metadata();
  const thumbnailRatio =
    thumbnail.width && thumbnail.height ? thumbnail.width / thumbnail.height : 0;
  if (
    thumbnail.format !== 'webp' ||
    !thumbnail.width ||
    !thumbnail.height ||
    thumbnail.width > 1600 ||
    thumbnail.height > 1600 ||
    Math.abs(thumbnailRatio - 16 / 9) > 0.02
  ) {
    throw new Error(`${slug}: thumbnail is not a bounded 16:9 WebP.`);
  }
  await sharp(verifiedThumbnail, {
    failOn: 'warning',
    limitInputPixels: 4_000_000,
  }).stats();
  const thumbnailDigest = sha256(verifiedThumbnail);
  if (expectedThumbnailSha256 && thumbnailDigest !== expectedThumbnailSha256) {
    throw new Error(`${slug}: thumbnail hash differs from staged metadata.`);
  }
  await writeFile(path.join(courseQaRoot, 'thumbnail.webp'), verifiedThumbnail);
  const contactSheetCount = await writeContactSheets(pagePngs, contactsRoot);
  const cta = finalPageText.match(CTA_PATTERN)?.[0] ?? null;
  const manifest = {
    schemaVersion: 1,
    slug,
    file: 'presentation.pdf',
    thumbnail: 'thumbnail.webp',
    mimeType: 'application/pdf',
    byteSize: pdfBytes.byteLength,
    sha256: digest,
    pageCount: expectedPageCount,
    aspectRatio: '16:9',
    renderedPageCount: pageResults.length,
    renderSize: { width: RENDER_WIDTH, height: RENDER_HEIGHT },
    validation: {
      automated: {
        status: 'passed',
        checks: [
          'signature',
          'size',
          'page-count',
          '16:9-render',
          'nonblank-pages',
          'text-layer',
          'all-page-actions',
          'thumbnail',
        ],
      },
      safety: {
        status: 'passed',
        encrypted: false,
        unsafeActionCount: 0,
        embeddedFileCount: 0,
      },
      visual: {
        status: visualQaApproved ? 'passed' : 'pending',
        method: 'all-pages-contact-sheets',
        reviewedPageCount: visualQaApproved ? pageResults.length : 0,
        contactSheetCount,
        reviewedAt: visualQaApproved ? reviewedAt : null,
      },
    },
    finalPageCta: cta,
    notesIncluded: false,
    thumbnailSha256: thumbnailDigest,
    pages: pageResults,
  };
  await writeFile(
    path.join(courseQaRoot, 'presentation-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return { manifest, thumbnailBytes: verifiedThumbnail };
}

export async function readPresentationQaInput(pdfPath, thumbnailPath = null) {
  const [pdfBytes, thumbnailBytes] = await Promise.all([
    readFile(pdfPath),
    thumbnailPath ? readFile(thumbnailPath) : null,
  ]);
  return { pdfBytes, thumbnailBytes };
}
