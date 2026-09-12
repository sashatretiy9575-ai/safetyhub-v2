import 'server-only';

const MAX_RENDER_EDGE = 640;
const MAX_RENDER_IMAGE_PIXELS = 8_000_000;
const MAX_RENDER_CANVAS_BYTES = MAX_RENDER_EDGE * MAX_RENDER_EDGE * 4;

function installCanvasGlobals(canvasModule: typeof import('@napi-rs/canvas')) {
  for (const [name, value] of [
    ['DOMMatrix', canvasModule.DOMMatrix],
    ['ImageData', canvasModule.ImageData],
    ['Path2D', canvasModule.Path2D],
  ] as const) {
    if (!(name in globalThis)) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: false,
        value,
        writable: true,
      });
    }
  }
}

function isPng(bytes: Uint8Array) {
  return (
    bytes.byteLength > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function hasEntries(value: unknown) {
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function mapValue(value: unknown, key: string) {
  if (value instanceof Map) return value.get(key);
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Parse the PDF with a second, independent implementation and render its
 * boundary pages to a small native canvas. This is intentionally server-side:
 * client inspection is only an editor convenience and is never trusted when a
 * presentation is promoted from staging.
 */
export async function renderPdfBoundaryPages(pdfBytes: Uint8Array, expectedPageCount: number) {
  const canvasModule = await import('@napi-rs/canvas');
  installCanvasGlobals(canvasModule);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingParameters = {
    data: pdfBytes.slice(),
    disableWorker: true,
    enableXfa: false,
    isEvalSupported: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_RENDER_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_RENDER_CANVAS_BYTES,
    stopAtErrors: true,
    useSystemFonts: true,
    useWasm: false,
  };
  const loadingTask = pdfjs.getDocument(loadingParameters);
  try {
    const document = await loadingTask.promise;
    if (document.numPages !== expectedPageCount) {
      throw new Error('PRESENTATION_PAGE_COUNT_MISMATCH');
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
      throw new Error('PRESENTATION_UNSAFE_ACTION');
    }
    for (let pageNumber = 1; pageNumber <= expectedPageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
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
      page.cleanup();
      if (hasEntries(pageJavaScript) || unsafeAnnotation) {
        throw new Error('PRESENTATION_UNSAFE_ACTION');
      }
    }
    for (const pageNumber of new Set([1, expectedPageCount])) {
      const page = await document.getPage(pageNumber);
      const original = page.getViewport({ scale: 1 });
      if (
        !Number.isFinite(original.width) ||
        !Number.isFinite(original.height) ||
        original.width <= 0 ||
        original.height <= 0
      ) {
        throw new Error('PRESENTATION_PAGE_DIMENSIONS_INVALID');
      }
      const scale = Math.min(
        1,
        MAX_RENDER_EDGE / original.width,
        MAX_RENDER_EDGE / original.height,
      );
      const viewport = page.getViewport({ scale });
      const canvas = canvasModule.createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
        intent: 'display',
        annotationMode: pdfjs.AnnotationMode.DISABLE,
        background: '#ffffff',
      }).promise;
      const rendered = canvas.toBuffer('image/png');
      if (!isPng(rendered)) throw new Error('PRESENTATION_PAGE_RENDER_FAILED');
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}
