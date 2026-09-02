import {
  assertCertificateExportMetadata,
  CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
  CERTIFICATE_RENDER_CONCURRENCY,
  type CertificateExportMetadata,
  type CertificateRenderMetadata,
} from './certificate-client-contract.ts';
import { certificateFilename } from './certificate.ts';
import { createStreamingZipArchive, type ArchiveEntry } from './certificate-archive.ts';
import { generateCertificateInBrowser, loadCertificateFontBytes, resolveAssetUrl } from './certificate-renderer.ts';
import { certificateReportRows, generateCertificateReportInBrowser } from './certificate-report.ts';
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
): AsyncGenerator<ArchiveEntry> {
  const sampleVerification = metadata.items[0]?.verificationUrl;
  const reportFont = await loadCertificateFontBytes(
    resolveAssetUrl(metadata.reportFontUrl, sampleVerification),
    signal,
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
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const batch = metadata.items.slice(offset, offset + CERTIFICATE_RENDER_CONCURRENCY);
    const generated = await Promise.all(
      batch.map(async (item: CertificateRenderMetadata) => ({
        item,
        bytes: await generateCertificateInBrowser(item, signal),
      })),
    );
    for (const { item, bytes } of generated) {
      completed += 1;
      workerPort.postMessage({
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
) {
  assertCertificateExportMetadata(metadata);
  if (!streamOutput && metadata.items.length > CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS) {
    throw new Error('CERTIFICATE_BUFFERED_ARCHIVE_LIMIT_EXCEEDED');
  }
  const archive = await createStreamingZipArchive(
    certificateArchiveEntries(metadata, taskId, signal),
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
      workerPort.postMessage({ type: 'chunk', taskId, sequence, bytes: buffer }, [buffer]);
      await acknowledged;
    } else {
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  }
  if (streamOutput) {
    workerPort.postMessage({ type: 'complete', taskId, filename: metadata.filename });
    return;
  }
  const archiveBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archiveBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const buffer = archiveBytes.buffer;
  workerPort.postMessage({ type: 'result', taskId, bytes: buffer, filename: metadata.filename }, [
    buffer,
  ]);
}

async function run(
  request: Exclude<CertificateWorkerRequest, { type: 'cancel' } | { type: 'chunk-ack' }>,
) {
  const controller = new AbortController();
  tasks.set(request.taskId, controller);
  try {
    if (request.type === 'render-certificate') {
      const bytes = await generateCertificateInBrowser(request.metadata, controller.signal);
      const buffer = transferableBytes(bytes);
      workerPort.postMessage(
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
    await renderArchive(request.taskId, request.metadata, request.stream, controller.signal);
  } catch (error) {
    workerPort.postMessage({
      type: 'error',
      taskId: request.taskId,
      code: errorCode(error),
    });
  } finally {
    chunkAcknowledgements.delete(request.taskId);
    tasks.delete(request.taskId);
  }
}

workerPort.addEventListener('message', (event) => {
  const request = event.data;
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
  void run(request);
});
