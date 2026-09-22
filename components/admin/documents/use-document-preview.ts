'use client';

import { useEffect, useRef, useState } from 'react';
import type { DocumentPreviewPending } from '@/components/admin/document-pdf-preview';
import {
  createBytesCache,
  isDiscreteChange,
  jobKey,
  type PreviewJob,
} from '@/lib/pdf/document-preview-job';

/** Long enough to fold a burst of picks into one generation, short enough to read as instant. */
const DISCRETE_RENDER_DELAY_MS = 150;
/** Typing waits for a pause before the document is drawn again. */
const TYPING_RENDER_DELAY_MS = 300;

export type DocumentPreviewTab = 'protocol' | 'certificate';

/**
 * Draws the document a job describes. A document already drawn comes back
 * from memory at once; typing waits for a pause, a choice only for the next
 * pick. The pages on the screen stay until the next ones are ready.
 */
export function useDocumentPreview(job: PreviewJob) {
  const [caches] = useState(() => createBytesCache());
  const [shown, setShown] = useState<{ key: string; job: PreviewJob; bytes: Uint8Array } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ key: string; text: string } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [retry, setRetry] = useState(0);
  const lastJob = useRef<PreviewJob | null>(null);
  const key = jobKey(job);

  useEffect(() => {
    const previous = lastJob.current;
    lastJob.current = job;
    setProblem(null);
    if (job.kind === 'message' || job.kind === 'wait') {
      if (job.kind === 'message') setShown(null);
      setRendering(false);
      return;
    }
    const cached = caches.get(key);
    if (cached) {
      setShown({ key, job, bytes: cached });
      setRendering(false);
      return;
    }
    const controller = new AbortController();
    setRendering(true);
    const timer = setTimeout(
      () => {
        void (async () => {
          let result: Uint8Array;
          if (job.kind === 'certificate') {
            const { generateCertificatePreview } = await import('@/lib/pdf/certificate-renderer');
            result = await generateCertificatePreview(job.input, controller.signal);
          } else {
            const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
            result = await generateProtocolInBrowser(
              job.input,
              job.branding,
              job.fontUrl,
              controller.signal,
            );
          }
          if (controller.signal.aborted) return;
          caches.set(key, result);
          setShown({ key, job, bytes: result });
        })()
          .catch((error) => {
            if (controller.signal.aborted) return;
            setProblem({
              key,
              text:
                error instanceof Error && error.message === 'DOCUMENT_TEXT_OVERFLOW'
                  ? 'Текст не помещается: сократите тексты'
                  : 'PDF не сформирован',
            });
          })
          .finally(() => {
            if (!controller.signal.aborted) setRendering(false);
          });
      },
      isDiscreteChange(previous, job) ? DISCRETE_RENDER_DELAY_MS : TYPING_RENDER_DELAY_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The key is the complete render input; `job` and `caches` are read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  const fresh = shown?.key === key;
  const pending: DocumentPreviewPending =
    fresh || job.kind === 'message'
      ? null
      : isDiscreteChange(shown?.job, job)
        ? 'replace'
        : 'refresh';
  return {
    bytes: job.kind === 'message' ? null : (shown?.bytes ?? null),
    pending,
    working: rendering,
    message: job.kind === 'message' ? job.text : problem?.key === key ? problem.text : '',
    retry() {
      caches.delete(key);
      setRetry((value) => value + 1);
    },
  };
}
