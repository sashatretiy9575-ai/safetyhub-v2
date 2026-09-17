'use client';

import { useEffect, useRef, useState } from 'react';

/** A phone shows half of the booklet at twice the width; its canvas must not exhaust memory. */
const MAX_CANVAS_SIDE = 4096;
/** The pages are redrawn when the frame changes by this much, not on every pixel of a resize. */
const WIDTH_STEP = 120;

/**
 * The PDF the administrator will download, drawn page by page as sharp as the
 * screen shows it. The previous pages stay until the next ones are ready, so
 * typing in a field never blanks the preview; while the preview is hidden
 * behind the fields on a phone nothing is drawn at all.
 */
export function DocumentPdfPreview({ bytes }: { bytes: Uint8Array | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const measure = () => setWidth(Math.ceil(container.clientWidth / WIDTH_STEP) * WIDTH_STEP);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    if (!bytes) {
      container.replaceChildren();
      return;
    }
    if (!width) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false });
      dispose = () => {
        void task.destroy();
      };
      const pdf = await task.promise;
      const fragment = document.createDocumentFragment();
      const pixels = Math.min(MAX_CANVAS_SIDE, width * Math.min(3, window.devicePixelRatio || 1));
      for (let pageNumber = 1; pageNumber <= pdf.numPages && !cancelled; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) break;
        const viewport = page.getViewport({
          scale: Math.max(1, pixels / page.getViewport({ scale: 1 }).width),
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.className = 'document-page';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'Страница ' + pageNumber);
        fragment.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      if (!cancelled) {
        container.replaceChildren(fragment);
        setFailed(false);
      }
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [bytes, width]);

  return (
    <>
      <div ref={host} className="document-pages" />
      {failed ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          Предпросмотр не загрузился
        </p>
      ) : null}
    </>
  );
}
