'use client';

import {
  assertCertificateExportMetadata,
  assertCertificateRenderMetadata,
  CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
  type CertificateExportMetadata,
  type CertificateRenderMetadata,
  type CertificateWorkerProgress,
} from './certificate-client-contract.ts';
import type {
  CertificateWorkerRequest,
  CertificateWorkerResponse,
} from './certificate-worker-protocol.ts';

type WritableDestination = Readonly<{
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}>;

export type CertificateArchiveFileHandle = Readonly<{
  createWritable(): Promise<WritableDestination>;
}>;

type SaveFilePickerWindow = Window &
  typeof globalThis & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<CertificateArchiveFileHandle>;
  };

type WorkerOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: CertificateWorkerProgress) => void;
  destination?: WritableDestination;
}>;

function workerError(code: string) {
  const error = new Error(code);
  error.name = code === 'CERTIFICATE_RENDER_CANCELLED' ? 'AbortError' : 'CertificateRenderError';
  return error;
}

function createCertificateWorker() {
  return new Worker(new URL('./certificate.worker.ts', import.meta.url), {
    type: 'module',
    name: 'safetyhub-certificate-renderer',
  });
}

async function runWorker(
  request: Exclude<CertificateWorkerRequest, { type: 'cancel' }>,
  options: WorkerOptions = {},
) {
  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const worker = createCertificateWorker();
  return new Promise<Readonly<{ bytes?: Uint8Array; filename: string }>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
      callback();
    };
    const abort = () => {
      worker.postMessage({
        type: 'cancel',
        taskId: request.taskId,
      } satisfies CertificateWorkerRequest);
      void options.destination?.abort(new DOMException('Cancelled', 'AbortError'));
      finish(() => reject(new DOMException('Cancelled', 'AbortError')));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.addEventListener('error', () => {
      void options.destination?.abort('CERTIFICATE_WORKER_FAILED');
      finish(() => reject(workerError('CERTIFICATE_WORKER_FAILED')));
    });
    worker.addEventListener('message', (event: MessageEvent<CertificateWorkerResponse>) => {
      const message = event.data;
      if (!message || message.taskId !== request.taskId) return;
      if (message.type === 'progress') {
        options.onProgress?.({ completed: message.completed, total: message.total });
        return;
      }
      if (message.type === 'chunk') {
        if (!options.destination) {
          finish(() => reject(workerError('CERTIFICATE_STREAM_DESTINATION_MISSING')));
          return;
        }
        void options.destination
          .write(message.bytes)
          .then(() => {
            if (settled) return;
            worker.postMessage({
              type: 'chunk-ack',
              taskId: request.taskId,
              sequence: message.sequence,
            } satisfies CertificateWorkerRequest);
          })
          .catch((error) => {
            void options.destination?.abort(error);
            finish(() => reject(error));
          });
        return;
      }
      if (message.type === 'error') {
        void options.destination?.abort(message.code);
        finish(() => reject(workerError(message.code)));
        return;
      }
      if (message.type === 'complete') {
        void Promise.resolve(options.destination?.close())
          .then(() => finish(() => resolve({ filename: message.filename })))
          .catch((error) => finish(() => reject(error)));
        return;
      }
      finish(() => resolve({ bytes: new Uint8Array(message.bytes), filename: message.filename }));
    });
    worker.postMessage(request);
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function requestCertificateArchiveFileHandle(
  suggestedName = 'safetyhub-certificates.zip',
): Promise<CertificateArchiveFileHandle | null> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  return picker({
    suggestedName,
    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
  });
}

export async function downloadCertificateInBrowser(
  metadata: CertificateRenderMetadata,
  options: Omit<WorkerOptions, 'destination'> = {},
) {
  assertCertificateRenderMetadata(metadata);
  try {
    const taskId = crypto.randomUUID();
    const result = await runWorker({ type: 'render-certificate', taskId, metadata }, options);
    if (result.bytes) {
      downloadBlob(
        new Blob([result.bytes.slice().buffer], { type: 'application/pdf' }),
        result.filename,
      );
      return;
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
  }

  const { generateCertificateInBrowser } = await import('./certificate-renderer.ts');
  const bytes = await generateCertificateInBrowser(metadata, options.signal);
  downloadBlob(
    new Blob([bytes.slice().buffer], { type: 'application/pdf' }),
    metadata.filename,
  );
}

function archivePartFilename(filename: string, part: number, count: number) {
  if (count === 1) return filename;
  const stem = filename.toLowerCase().endsWith('.zip') ? filename.slice(0, -4) : filename;
  return `${stem}-part-${part}-of-${count}.zip`;
}

export async function downloadCertificateExportInBrowser(
  metadata: CertificateExportMetadata,
  options: WorkerOptions & { fileHandle?: CertificateArchiveFileHandle | null } = {},
) {
  assertCertificateExportMetadata(metadata);
  if (options.fileHandle) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const destination = await options.fileHandle.createWritable();
    const taskId = crypto.randomUUID();
    try {
      await runWorker(
        { type: 'render-archive', taskId, metadata, stream: true },
        { ...options, destination },
      );
    } catch (error) {
      await destination.abort(error).catch(() => undefined);
      throw error;
    }
    return { archives: 1, streamed: true } as const;
  }

  const partCount = Math.max(
    1,
    Math.ceil(metadata.items.length / CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS),
  );
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const items = metadata.items.slice(
      partIndex * CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
      (partIndex + 1) * CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
    );
    const partMetadata: CertificateExportMetadata = {
      ...metadata,
      filename: archivePartFilename(metadata.filename, partIndex + 1, partCount),
      requested: items.length,
      total: items.length,
      eligible: items.length,
      skipped: [],
      items,
    };
    const taskId = crypto.randomUUID();
    const result = await runWorker(
      { type: 'render-archive', taskId, metadata: partMetadata, stream: false },
      {
        signal: options.signal,
        onProgress: (progress) =>
          options.onProgress?.({
            completed: partIndex * CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS + progress.completed,
            total: metadata.items.length,
          }),
      },
    );
    if (!result.bytes) throw workerError('CERTIFICATE_ARCHIVE_EMPTY');
    downloadBlob(
      new Blob([result.bytes.slice().buffer], { type: 'application/zip' }),
      result.filename,
    );
  }
  return { archives: partCount, streamed: false } as const;
}
