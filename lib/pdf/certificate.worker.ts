import {
  assertCertificateExportMetadata,
  CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
  CERTIFICATE_RENDER_CONCURRENCY,
  type CertificateExportMetadata,
  type CertificateRenderMetadata,
} from './certificate-client-contract.ts';
import { certificateFilename } from './certificate.ts';
import { createStreamingZipArchive, type ArchiveEntry } from './certificate-archive.ts';
import { generateCertificateInBrowser } from './certificate-renderer.ts';
import {
  CERTIFICATE_REPORT_FILENAME,
  certificateReportRows,
  generateCertificateReportWorkbook,
} from './certificate-report-xlsx.ts';
import {
  generateProtocolInBrowser,
  groupItemsForProtocols,
  protocolFilename,
} from './protocol-renderer.ts';
import type {
  CertificateWorkerRequest,
  CertificateWorkerResponse,
} from './certificate-worker-protocol.ts';

type WorkerPort = Readonly<{
  postMessage(message: CertificateWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CertificateWorkerRequest>) => void,
  ): void;
}>;

type Respond = (message: CertificateWorkerResponse, transfer?: Transferable[]) => void;
type RenderSlot = (metadata: CertificateRenderMetadata, signal: AbortSignal) => Promise<Uint8Array>;

// A helper that stops answering (crashed, killed by the browser) must not
// hang the whole export; the coordinator gives up on it and the client falls
// back to rendering on the main thread.
const REMOTE_RENDER_TIMEOUT_MS = 60_000;

const workerPort = self as unknown as WorkerPort;
const tasks = new Map<string, AbortController>();
const chunkAcknowledgements = new Map<
  string,
  { sequence: number; resolve: () => void; reject: (reason: unknown) => void }
>();

function errorCode(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'CERTIFICATE_RENDER_CANCELLED';
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,96}$/u.test(error.message)) return error.message;
  return 'CERTIFICATE_RENDER_FAILED';
}

function transferableBytes(bytes: Uint8Array) {
  return bytes.slice().buffer;
}

/**
 * A helper worker reached through a MessagePort. It renders one certificate
 * per request; the coordinator keeps as many of these busy as the machine has
 * spare cores while it assembles the archive.
 */
class RemoteRenderer {
  private readonly pending = new Map<
    string,
    { resolve: (bytes: Uint8Array) => void; reject: (reason: unknown) => void }
  >();

  constructor(private readonly port: MessagePort) {
    port.addEventListener('message', (event: MessageEvent<CertificateWorkerResponse>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      const waiter = this.pending.get(message.taskId);
      if (!waiter) return;
      if (message.type === 'result') {
        this.pending.delete(message.taskId);
        waiter.resolve(new Uint8Array(message.bytes));
      } else if (message.type === 'error') {
        this.pending.delete(message.taskId);
        waiter.reject(new Error(message.code));
      }
    });
    port.start();
  }

  render(metadata: CertificateRenderMetadata, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    const taskId = crypto.randomUUID();
    return new Promise<Uint8Array>((resolve, reject) => {
      const settle = () => {
        signal.removeEventListener('abort', abort);
        clearTimeout(timer);
        this.pending.delete(taskId);
      };
      const abort = () => {
        settle();
        this.port.postMessage({ type: 'cancel', taskId } satisfies CertificateWorkerRequest);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error('CERTIFICATE_RENDER_HELPER_TIMEOUT'));
      }, REMOTE_RENDER_TIMEOUT_MS);
      this.pending.set(taskId, {
        resolve: (bytes) => {
          settle();
          resolve(bytes);
        },
        reject: (reason) => {
          settle();
          reject(reason);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      this.port.postMessage({
        type: 'render-certificate',
        taskId,
        metadata,
      } satisfies CertificateWorkerRequest);
    });
  }
}

// Helpers attached by the first archive request of a session and reused by
// every following part; the client terminates all of them together.
let remoteRenderers: RemoteRenderer[] = [];

function renderSlots(): RenderSlot[] {
  const local: RenderSlot = (metadata, signal) => generateCertificateInBrowser(metadata, signal);
  const remote: RenderSlot[] = remoteRenderers.map(
    (renderer) => (metadata, signal) => renderer.render(metadata, signal),
  );
  // This worker renders too, so a machine without spare cores behaves as
  // before: CERTIFICATE_RENDER_CONCURRENCY documents in flight, all local.
  const slots = [...remote, local];
  while (slots.length < CERTIFICATE_RENDER_CONCURRENCY) slots.push(local);
  return slots;
}

function waitForChunkAcknowledgement(taskId: string, sequence: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  if (chunkAcknowledgements.has(taskId)) {
    return Promise.reject(new Error('CERTIFICATE_STREAM_ACK_STATE_INVALID'));
  }
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      chunkAcknowledgements.delete(taskId);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    chunkAcknowledgements.set(taskId, {
      sequence,
      resolve: () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      reject,
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function* certificateArchiveEntries(
  metadata: CertificateExportMetadata,
  taskId: string,
  signal: AbortSignal,
  respond: Respond,
): AsyncGenerator<ArchiveEntry> {
  const report = await generateCertificateReportWorkbook(
    certificateReportRows(metadata.items),
    new Date(metadata.generatedAt),
  );
  yield { name: CERTIFICATE_REPORT_FILENAME, bytes: report };

  // One protocol per company and course, before the certificates it lists.
  for (const group of groupItemsForProtocols(metadata.items)) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const branding = group.items[0]!.branding;
    yield {
      name: protocolFilename(group, branding.protocolNumber),
      bytes: await generateProtocolInBrowser(group, branding, metadata.reportFontUrl, signal),
    };
  }

  const slots = renderSlots();
  let completed = 0;
  for (let offset = 0; offset < metadata.items.length; offset += slots.length) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const batch = metadata.items.slice(offset, offset + slots.length);
    const generated = await Promise.all(
      batch.map(async (item: CertificateRenderMetadata, index) => ({
        item,
        bytes: await slots[index]!(item, signal),
      })),
    );
    for (const { item, bytes } of generated) {
      completed += 1;
      respond({
        type: 'progress',
        taskId,
        completed,
        total: metadata.items.length,
      });
      yield {
        name: `certificates/${certificateFilename(item.certificateNumber, item.fullName)}`,
        bytes,
      };
    }
  }
}

async function renderArchive(
  taskId: string,
  metadata: CertificateExportMetadata,
  streamOutput: boolean,
  signal: AbortSignal,
  respond: Respond,
) {
  assertCertificateExportMetadata(metadata);
  if (!streamOutput && metadata.items.length > CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS) {
    throw new Error('CERTIFICATE_BUFFERED_ARCHIVE_LIMIT_EXCEEDED');
  }
  const archive = await createStreamingZipArchive(
    certificateArchiveEntries(metadata, taskId, signal, respond),
  );
  const reader = archive.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let sequence = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel();
      throw new DOMException('Cancelled', 'AbortError');
    }
    const { value, done } = await reader.read();
    if (done) break;
    if (streamOutput) {
      sequence += 1;
      const buffer = transferableBytes(value);
      const acknowledged = waitForChunkAcknowledgement(taskId, sequence, signal);
      respond({ type: 'chunk', taskId, sequence, bytes: buffer }, [buffer]);
      await acknowledged;
    } else {
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  }
  if (streamOutput) {
    respond({ type: 'complete', taskId, filename: metadata.filename });
    return;
  }
  const archiveBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archiveBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const buffer = archiveBytes.buffer;
  respond({ type: 'result', taskId, bytes: buffer, filename: metadata.filename }, [buffer]);
}

async function run(
  request: Exclude<
    CertificateWorkerRequest,
    { type: 'cancel' } | { type: 'chunk-ack' } | { type: 'serve' }
  >,
  respond: Respond,
) {
  const controller = new AbortController();
  tasks.set(request.taskId, controller);
  try {
    if (request.type === 'render-certificate') {
      const bytes = await generateCertificateInBrowser(request.metadata, controller.signal);
      const buffer = transferableBytes(bytes);
      respond(
        {
          type: 'result',
          taskId: request.taskId,
          bytes: buffer,
          filename: request.metadata.filename,
        },
        [buffer],
      );
      return;
    }
    if (request.renderPorts && request.renderPorts.length > 0) {
      remoteRenderers = request.renderPorts.map((port) => new RemoteRenderer(port));
    }
    await renderArchive(
      request.taskId,
      request.metadata,
      request.stream,
      controller.signal,
      respond,
    );
  } catch (error) {
    respond({
      type: 'error',
      taskId: request.taskId,
      code: errorCode(error),
    });
  } finally {
    chunkAcknowledgements.delete(request.taskId);
    tasks.delete(request.taskId);
  }
}

function handleRequest(request: CertificateWorkerRequest | null | undefined, respond: Respond) {
  if (!request || typeof request !== 'object' || typeof request.taskId !== 'string') return;
  if (request.type === 'cancel') {
    tasks.get(request.taskId)?.abort();
    return;
  }
  if (request.type === 'chunk-ack') {
    const pending = chunkAcknowledgements.get(request.taskId);
    if (
      pending &&
      Number.isSafeInteger(request.sequence) &&
      request.sequence > 0 &&
      pending.sequence === request.sequence
    ) {
      chunkAcknowledgements.delete(request.taskId);
      pending.resolve();
    }
    return;
  }
  if (request.type === 'serve') {
    const port = request.port;
    port.addEventListener('message', (event: MessageEvent<CertificateWorkerRequest>) => {
      handleRequest(event.data, (message, transfer) => port.postMessage(message, transfer ?? []));
    });
    port.start();
    return;
  }
  void run(request, respond);
}

workerPort.addEventListener('message', (event) => {
  handleRequest(event.data, (message, transfer) => workerPort.postMessage(message, transfer));
});
