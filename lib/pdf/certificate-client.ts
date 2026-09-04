'use client';

import {
  assertCertificateExportMetadata,
  assertCertificateRenderMetadata,
  CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
  CERTIFICATE_RENDER_CONCURRENCY,
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

/** File System Access streams also accept positional commands. */
type SeekableDestination = Readonly<{
  write(command: { type: 'truncate'; size: number } | { type: 'seek'; position: number }): Promise<void>;
}>;

function writtenByteLength(data: BufferSource | Blob | string) {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
  if (data instanceof Blob) return data.size;
  return data.byteLength;
}

/**
 * Wraps the picked file so a failed worker run can be retried on the main
 * thread without corrupting the archive.
 *
 * The worker path aborts the destination from three of its own error handlers.
 * Forwarding those aborts immediately destroyed the only handle we had, and the
 * retry then appended a second ZIP after the bytes the worker had already
 * written — producing exactly the "damaged archive" users reported. The wrapper
 * defers the abort, counts what actually reached the file, and can rewind the
 * file to zero before a retry.
 */
function createRewindableDestination(target: WritableDestination) {
  let bytesWritten = 0;
  let closed = false;

  const proxy: WritableDestination = {
    async write(data) {
      await target.write(data);
      bytesWritten += writtenByteLength(data);
    },
    async close() {
      await target.close();
      closed = true;
    },
    async abort() {
      // Deliberately deferred: the caller decides between rewind and abort.
    },
  };

  return {
    proxy,
    async rewind() {
      if (closed) return false;
      if (bytesWritten === 0) return true;
      try {
        await (target as unknown as SeekableDestination).write({ type: 'truncate', size: 0 });
        await (target as unknown as SeekableDestination).write({ type: 'seek', position: 0 });
        bytesWritten = 0;
        return true;
      } catch {
        return false;
      }
    },
  };
}

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

async function renderArchiveInMainThread(
  metadata: CertificateExportMetadata,
  options: WorkerOptions & { destination?: WritableDestination },
): Promise<Uint8Array | null> {
  const { createStreamingZipArchive } = await import('./certificate-archive.ts');
  const { generateCertificateInBrowser, loadCertificateFontBytes, resolveAssetUrl } = await import(
    './certificate-renderer.ts'
  );
  const { certificateReportRows, generateCertificateReportInBrowser } = await import(
    './certificate-report.ts'
  );
  const { certificateFilename } = await import('./certificate.ts');

  async function* entriesGenerator(): AsyncGenerator<{ name: string; bytes: Uint8Array }> {
    const sampleVerification = metadata.items[0]?.verificationUrl;
    const reportFont = await loadCertificateFontBytes(
      resolveAssetUrl(metadata.reportFontUrl, sampleVerification),
      options.signal,
    );
    const report = await generateCertificateReportInBrowser(
      certificateReportRows(metadata.items),
      new Date(metadata.generatedAt),
      reportFont,
      metadata.reportFontUrl.includes('locale=zh'),
    );
    yield { name: 'report.pdf', bytes: report };

    let completed = 0;
    for (let offset = 0; offset < metadata.items.length; offset += CERTIFICATE_RENDER_CONCURRENCY) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const batch = metadata.items.slice(offset, offset + CERTIFICATE_RENDER_CONCURRENCY);
      const generated = await Promise.all(
        batch.map(async (item) => ({
          item,
          bytes: await generateCertificateInBrowser(item, options.signal),
        })),
      );
      for (const { item, bytes } of generated) {
        completed += 1;
        options.onProgress?.({ completed, total: metadata.items.length });
        yield {
          name: `certificates/${certificateFilename(item.certificateNumber, item.fullName)}`,
          bytes,
        };
      }
    }
  }

  const stream = await createStreamingZipArchive(entriesGenerator());
  const reader = stream.getReader();
  if (options.destination) {
    try {
      while (true) {
        if (options.signal?.aborted) {
          await reader.cancel();
          throw new DOMException('Cancelled', 'AbortError');
        }
        const { value, done } = await reader.read();
        if (done) break;
        await options.destination.write(value.slice().buffer);
      }
      await options.destination.close();
    } catch (error) {
      await options.destination.abort(error).catch(() => undefined);
      throw error;
    }
    return null;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    if (options.signal?.aborted) {
      await reader.cancel();
      throw new DOMException('Cancelled', 'AbortError');
    }
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  const resultBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    resultBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return resultBytes;
}

export async function downloadCertificateExportInBrowser(
  metadata: CertificateExportMetadata,
  options: WorkerOptions & { fileHandle?: CertificateArchiveFileHandle | null } = {},
) {
  assertCertificateExportMetadata(metadata);
  if (options.fileHandle) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const destination = await options.fileHandle.createWritable();
    const rewindable = createRewindableDestination(destination);
    const taskId = crypto.randomUUID();
    try {
      await runWorker(
        { type: 'render-archive', taskId, metadata, stream: true },
        { ...options, destination: rewindable.proxy },
      );
    } catch (workerError) {
      if (options.signal?.aborted) {
        await destination.abort(workerError).catch(() => undefined);
        throw workerError;
      }
      // Retrying on top of a partially written file would produce a broken
      // archive, so a file that cannot be rewound is abandoned instead.
      if (!(await rewindable.rewind())) {
        await destination.abort(workerError).catch(() => undefined);
        throw workerError;
      }
      try {
        await renderArchiveInMainThread(metadata, {
          ...options,
          destination: rewindable.proxy,
        });
      } catch (fallbackError) {
        await destination.abort(fallbackError).catch(() => undefined);
        throw fallbackError;
      }
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
    let archiveBytes: Uint8Array | null = null;
    try {
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
      archiveBytes = result.bytes ? new Uint8Array(result.bytes) : null;
    } catch (workerError) {
      if (options.signal?.aborted) throw workerError;
      archiveBytes = await renderArchiveInMainThread(partMetadata, {
        signal: options.signal,
        onProgress: (progress) =>
          options.onProgress?.({
            completed: partIndex * CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS + progress.completed,
            total: metadata.items.length,
          }),
      });
    }
    if (!archiveBytes) throw workerError('CERTIFICATE_ARCHIVE_EMPTY');
    downloadBlob(
      new Blob([archiveBytes.slice().buffer], { type: 'application/zip' }),
      partMetadata.filename,
    );
  }
  return { archives: partCount, streamed: false } as const;
}
