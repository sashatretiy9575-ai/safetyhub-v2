'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type Pdfjs = typeof import('pdfjs-dist');
type PdfWorker = InstanceType<Pdfjs['PDFWorker']>;
/**
 * `refresh`: the same document is being redrawn, its pages stay and are dimmed.
 * `replace`: another document is coming, the pages only keep the height of the box.
 */
export type DocumentPreviewPending = 'refresh' | 'replace' | null;

/** A phone shows half of the booklet at twice the width; its canvas must not exhaust memory. */
const MAX_CANVAS_SIDE = 4096;
/** The pages are redrawn when the frame changes by this much, not on every pixel of a resize. */
const WIDTH_STEP = 120;

// One parser thread for as long as a preview is on the page. Without it pdf.js
// started a Worker for every draw and compiled 1.2 MB of its code in it again.
let sharedWorker: PdfWorker | null = null;
let sharedWorkerUsers = 0;

function previewWorker(pdfjs: Pdfjs): PdfWorker {
  if (!sharedWorker || sharedWorker.destroyed) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    sharedWorker = pdfjs.PDFWorker.create({});
  }
  return sharedWorker;
}

/**
 * The PDF the administrator will download, drawn page by page as sharp as the
 * screen shows it. The previous pages stay until the next ones are ready, so
 * typing in a field never blanks the preview; while the preview is hidden
 * behind the fields on a phone nothing is drawn at all, and coming back to it
 * draws nothing that is already there.
 */
export function DocumentPdfPreview({
  bytes,
  pending = null,
}: {
  bytes: Uint8Array | null;
  pending?: DocumentPreviewPending;
}) {
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef<{ bytes: Uint8Array; width: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState<Uint8Array | null>(null);
  const [waiting, setWaiting] = useState<DocumentPreviewPending>(null);

  // The parent stops announcing a wait the moment the bytes arrive, but their
  // pages are still being drawn: the wait lasts until they are swapped in.
  const mode = pending ?? (bytes === shown ? null : waiting);
  if (mode !== waiting) setWaiting(mode);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    // A hidden frame is 0 px wide. That is not a new width: the pages drawn for
    // the last real one are still right when the frame comes back.
    const measure = () => {
      const next = Math.ceil(container.clientWidth / WIDTH_STEP) * WIDTH_STEP;
      setVisible(next > 0);
      if (next) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Only a message takes the pages away. While a document is on its way they
  // hold the height of the box, so what is under it does not move twice.
  useEffect(() => {
    if (bytes || pending) return;
    host.current?.replaceChildren();
    drawn.current = null;
    setShown(null);
    setFailed(false);
  }, [bytes, pending]);

  useEffect(() => {
    const container = host.current;
    if (!container || !bytes || !visible || !width) return;
    if (drawn.current?.bytes === bytes && drawn.current.width === width) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const started = performance.now();
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (cancelled) return;
      const task = pdfjs.getDocument({
        data: bytes.slice(),
        enableXfa: false,
        worker: previewWorker(pdfjs),
      });
      let rendering: { cancel(): void } | undefined;
      // Destroying a document of a worker that is already gone may reject; nobody waits for it.
      dispose = () => {
        rendering?.cancel();
        void task.destroy().catch(() => {});
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
        const renderTask = page.render({ canvas, viewport });
        rendering = renderTask;
        await renderTask.promise;
        rendering = undefined;
      }
      if (cancelled) return;
      container.replaceChildren(fragment);
      drawn.current = { bytes, width };
      setShown(bytes);
      setFailed(false);
      // The canvases hold the pixels; the parsed document is not needed again.
      dispose();
      try {
        performance.measure('doc:draw', { start: started, end: performance.now() });
      } catch {
        // An engine without measure options simply records no spans.
      }
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [bytes, width, visible]);

  // Declared last: on unmount the draw above lets go of its document first,
  // then the last preview on the page takes the worker with it.
  useEffect(() => {
    sharedWorkerUsers++;
    return () => {
      if (--sharedWorkerUsers > 0) return;
      sharedWorker?.destroy();
      sharedWorker = null;
    };
  }, []);

  return (
    <>
      <div
        ref={host}
        aria-busy={mode ? true : undefined}
        className={cn(
          'document-pages transition-opacity',
          mode === 'refresh' && 'opacity-60',
          mode === 'replace' && 'invisible',
        )}
      />
      {failed ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          Предпросмотр не загрузился
        </p>
      ) : null}
    </>
  );
}
