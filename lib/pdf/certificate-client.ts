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
import {
  archivePartsByProtocol,
  groupCertificateExportByOrganization,
} from './certificate-export-groups.ts';
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
  write(
    command: { type: 'truncate'; size: number } | { type: 'seek'; position: number },
  ): Promise<void>;
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

/**
 * The workers of one export: a coordinator that assembles the archive and
 * renders, plus helpers that render certificates in parallel on the other
 * cores. Created once per export and reused for every archive part and every
 * company, so the fonts are fetched and parsed once instead of once per part.
 */
type RenderPool = {
  readonly coordinator: Worker;
  readonly helpers: readonly Worker[];
  /** Transferred to the coordinator with its first archive request. */
  pendingPorts: MessagePort[];
  /** A crashed or cancelled worker is never reused; the rest of the export renders on the main thread. */
  broken: boolean;
  terminate(): void;
};

// Three helpers plus the coordinator keep a four-core laptop busy without
// starving the tab; more cores render no faster on a two-page booklet.
const MAX_RENDER_HELPERS = 3;

function createRenderPool(): RenderPool {
  const coordinator = createCertificateWorker();
  const spareCores = Math.max(0, (navigator.hardwareConcurrency ?? 2) - 1);
  const helpers: Worker[] = [];
  const pendingPorts: MessagePort[] = [];
  for (let index = 0; index < Math.min(MAX_RENDER_HELPERS, spareCores); index += 1) {
    const helper = createCertificateWorker();
    const channel = new MessageChannel();
    helper.postMessage(
      { type: 'serve', taskId: '', port: channel.port2 } satisfies CertificateWorkerRequest,
      [channel.port2],
    );
    helpers.push(helper);
    pendingPorts.push(channel.port1);
  }
  const pool: RenderPool = {
    coordinator,
    helpers,
    pendingPorts,
    broken: false,
    terminate() {
      coordinator.terminate();
      for (const helper of helpers) helper.terminate();
    },
  };
  for (const helper of helpers) {
    helper.addEventListener('error', () => {
      pool.broken = true;
    });
  }
  return pool;
}

async function runWorker(
  request: Exclude<
    CertificateWorkerRequest,
    { type: 'cancel' } | { type: 'chunk-ack' } | { type: 'serve' }
  >,
  options: WorkerOptions = {},
  pool?: RenderPool,
) {
  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const worker = pool ? pool.coordinator : createCertificateWorker();
  const transfer: Transferable[] = [];
  if (request.type === 'render-archive' && pool && pool.pendingPorts.length > 0) {
    request = { ...request, renderPorts: pool.pendingPorts };
    transfer.push(...pool.pendingPorts);
    pool.pendingPorts = [];
  }
  return new Promise<Readonly<{ bytes?: Uint8Array; filename: string }>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('message', onMessage);
      // A pooled coordinator lives on for the next part; a one-off worker does not.
      if (!pool) worker.terminate();
      callback();
    };
    const abort = () => {
      worker.postMessage({
        type: 'cancel',
        taskId: request.taskId,
      } satisfies CertificateWorkerRequest);
      if (pool) pool.broken = true;
      void options.destination?.abort(new DOMException('Cancelled', 'AbortError'));
      finish(() => reject(new DOMException('Cancelled', 'AbortError')));
    };
    const onError = () => {
      if (pool) pool.broken = true;
      void options.destination?.abort('CERTIFICATE_WORKER_FAILED');
      finish(() => reject(workerError('CERTIFICATE_WORKER_FAILED')));
    };
    const onMessage = (event: MessageEvent<CertificateWorkerResponse>) => {
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
        if (pool) pool.broken = true;
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
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.addEventListener('error', onError);
    worker.addEventListener('message', onMessage);
    worker.postMessage(request, transfer);
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
  downloadBlob(new Blob([bytes.slice().buffer], { type: 'application/pdf' }), metadata.filename);
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
  const { generateCertificateInBrowser } = await import('./certificate-renderer.ts');
  const { CERTIFICATE_REPORT_FILENAME, certificateReportRows, generateCertificateReportWorkbook } =
    await import('./certificate-report-xlsx.ts');
  const { generateProtocolInBrowser, groupItemsForProtocols, protocolFilename } =
    await import('./protocol-renderer.ts');
  const { certificateFilename } = await import('./certificate.ts');

  async function* entriesGenerator(): AsyncGenerator<{ name: string; bytes: Uint8Array }> {
    const report = await generateCertificateReportWorkbook(
      certificateReportRows(metadata.items),
      new Date(metadata.generatedAt),
    );
    yield { name: CERTIFICATE_REPORT_FILENAME, bytes: report };
    for (const group of groupItemsForProtocols(metadata.items)) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const branding = group.items[0]!.branding;
      yield {
        name: protocolFilename(group, branding.protocolNumber),
        bytes: await generateProtocolInBrowser(
          group,
          branding,
          metadata.reportFontUrl,
          options.signal,
        ),
      };
    }

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

/** Chrome coalesces programmatic downloads fired back to back; a short pause
 * between archives keeps every file. */
async function pauseBetweenDownloads(signal: AbortSignal | undefined) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, 300);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Renders one export as ≤100-certificate archives and hands each to the browser. */
async function renderBufferedArchiveParts(
  metadata: CertificateExportMetadata,
  options: WorkerOptions,
  pool: RenderPool,
): Promise<number> {
  // Whole protocols per part: a protocol is never printed in two archives.
  const parts = archivePartsByProtocol(metadata.items, CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS);
  const partCount = parts.length;
  let done = 0;
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (partIndex > 0) await pauseBetweenDownloads(options.signal);
    const items = parts[partIndex]!;
    const before = done;
    done += items.length;
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
    const onProgress = (progress: CertificateWorkerProgress) =>
      options.onProgress?.({
        completed: before + progress.completed,
        total: metadata.items.length,
      });
    let archiveBytes: Uint8Array | null = null;
    if (!pool.broken) {
      try {
        const result = await runWorker(
          { type: 'render-archive', taskId, metadata: partMetadata, stream: false },
          { signal: options.signal, onProgress },
          pool,
        );
        archiveBytes = result.bytes ? new Uint8Array(result.bytes) : null;
      } catch (workerFailure) {
        if (options.signal?.aborted) throw workerFailure;
        archiveBytes = null;
      }
    }
    if (!archiveBytes) {
      archiveBytes = await renderArchiveInMainThread(partMetadata, {
        signal: options.signal,
        onProgress,
      });
    }
    if (!archiveBytes) throw workerError('CERTIFICATE_ARCHIVE_EMPTY');
    downloadBlob(
      new Blob([archiveBytes.slice().buffer], { type: 'application/zip' }),
      partMetadata.filename,
    );
  }
  return partCount;
}

export async function downloadCertificateExportInBrowser(
  metadata: CertificateExportMetadata,
  options: WorkerOptions & {
    fileHandle?: CertificateArchiveFileHandle | null;
    /** `organization`: one archive per company, named after it. */
    groupBy?: 'none' | 'organization';
  } = {},
) {
  assertCertificateExportMetadata(metadata);
  const pool = createRenderPool();
  try {
    if (options.fileHandle) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const destination = await options.fileHandle.createWritable();
      const rewindable = createRewindableDestination(destination);
      const taskId = crypto.randomUUID();
      try {
        await runWorker(
          { type: 'render-archive', taskId, metadata, stream: true },
          { ...options, destination: rewindable.proxy },
          pool,
        );
      } catch (workerFailure) {
        if (options.signal?.aborted) {
          await destination.abort(workerFailure).catch(() => undefined);
          throw workerFailure;
        }
        // Retrying on top of a partially written file would produce a broken
        // archive, so a file that cannot be rewound is abandoned instead.
        if (!(await rewindable.rewind())) {
          await destination.abort(workerFailure).catch(() => undefined);
          throw workerFailure;
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
      return { archives: 1, streamed: true, companies: 1 } as const;
    }

    // Operators file certificates by company, so a mixed selection leaves the
    // browser as one archive per company. The metadata was fetched once for the
    // whole selection; only the rendering is split.
    const groups =
      options.groupBy === 'organization'
        ? groupCertificateExportByOrganization(metadata)
        : [{ key: '', organization: null, metadata }];
    let archives = 0;
    let completedBefore = 0;
    for (const [index, group] of groups.entries()) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (index > 0) await pauseBetweenDownloads(options.signal);
      archives += await renderBufferedArchiveParts(
        group.metadata,
        {
          signal: options.signal,
          onProgress: (progress) =>
            options.onProgress?.({
              completed: completedBefore + progress.completed,
              total: metadata.items.length,
            }),
        },
        pool,
      );
      completedBefore += group.metadata.items.length;
    }
    return { archives, streamed: false, companies: groups.length } as const;
  } finally {
    pool.terminate();
  }
}
