'use client';

import { useEffect, useState } from 'react';
import {
  downloadCertificateExportInBrowser,
  type CertificateArchiveFileHandle,
} from '@/lib/pdf/certificate-client';
import {
  CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
  CERTIFICATE_CLIENT_SCHEMA_VERSION,
  CERTIFICATE_EXPORT_MAX_ITEMS,
  CERTIFICATE_RENDER_CONCURRENCY,
  type CertificateExportMetadata,
} from '@/lib/pdf/certificate-client-contract';

declare global {
  interface Window {
    __zipResult?: { mode: string; base64: string; bytes: number; entries?: string[]; error?: string };
  }
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function buildMetadata(count: number): CertificateExportMetadata {
  const origin = window.location.origin;
  const now = new Date().toISOString();
  const items = Array.from({ length: count }, (_, index) => ({
    schemaVersion: CERTIFICATE_CLIENT_SCHEMA_VERSION,
    certificateId: crypto.randomUUID(),
    filename: `certificate-${index + 1}.pdf`,
    locale: 'ru' as const,
    templateVersion: 1,
    titleSnapshot: 'Безопасность и охрана труда',
    templateUrl: '/certificates/template-v1.pdf',
    fontUrl: '/certificate-assets/font?locale=ru&v=1',
    fullName: `Иванов Иван ${index + 1}`,
    position: 'Инженер',
    organization: 'ТОО «Тест»',
    score: 9,
    total: 10,
    passScore: 7,
    certificateNumber: `SH-2026-TEST${String(index + 1).padStart(4, '0')}`,
    completedAt: now,
    issuedAt: now,
    verificationUrl: `${origin}/verify/v1.test${index + 1}`,
  }));
  return {
    schemaVersion: CERTIFICATE_CLIENT_SCHEMA_VERSION,
    filename: 'safetyhub-certificates-test.zip',
    generatedAt: now,
    requested: count,
    total: count,
    eligible: count,
    reportFontUrl: '/certificate-assets/font?locale=ru&v=1',
    skipped: [],
    items,
    archivePolicy: {
      maxItemsPerBufferedArchive: CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
      maxItems: CERTIFICATE_EXPORT_MAX_ITEMS,
      renderConcurrency: CERTIFICATE_RENDER_CONCURRENCY,
    },
  };
}

function concat(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function verify(bytes: Uint8Array) {
  const { unzipSync } = await import('fflate');
  return Object.keys(unzipSync(bytes));
}

export function ZipHarnessClient() {
  const [mounted, setMounted] = useState(false);
  const [log, setLog] = useState('idle');

  useEffect(() => {
    setMounted(true);
  }, []);

  const runStreaming = async (count: number) => {
    setLog('streaming…');
    const chunks: Uint8Array[] = [];
    const fileHandle: CertificateArchiveFileHandle = {
      createWritable: async () => ({
        write: async (data: BufferSource | Blob | string) => {
          if (data instanceof ArrayBuffer) chunks.push(new Uint8Array(data));
          else if (ArrayBuffer.isView(data)) chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          else if (data instanceof Blob) chunks.push(new Uint8Array(await data.arrayBuffer()));
          else chunks.push(new TextEncoder().encode(String(data)));
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
    try {
      await downloadCertificateExportInBrowser(buildMetadata(count), {
        fileHandle,
        onProgress: (progress) => setLog(`streaming ${progress.completed}/${progress.total}`),
      });
      const bytes = concat(chunks);
      const entries = await verify(bytes);
      window.__zipResult = { mode: 'stream', base64: toBase64(bytes), bytes: bytes.byteLength, entries };
      setLog(`stream ok: ${bytes.byteLength} bytes, ${entries.length} entries`);
    } catch (error) {
      window.__zipResult = { mode: 'stream', base64: '', bytes: 0, error: String(error) };
      setLog(`stream error: ${String(error)}`);
    }
  };

  const runBuffered = async (count: number) => {
    setLog('buffered…');
    const original = URL.createObjectURL;
    let captured: Blob | null = null;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob) captured = blob;
      return 'blob:captured';
    };
    try {
      await downloadCertificateExportInBrowser(buildMetadata(count), {
        onProgress: (progress) => setLog(`buffered ${progress.completed}/${progress.total}`),
      });
      if (!captured) throw new Error('no blob captured');
      const bytes = new Uint8Array(await (captured as Blob).arrayBuffer());
      const entries = await verify(bytes);
      window.__zipResult = { mode: 'buffered', base64: toBase64(bytes), bytes: bytes.byteLength, entries };
      setLog(`buffered ok: ${bytes.byteLength} bytes, ${entries.length} entries`);
    } catch (error) {
      window.__zipResult = { mode: 'buffered', base64: '', bytes: 0, error: String(error) };
      setLog(`buffered error: ${String(error)}`);
    } finally {
      URL.createObjectURL = original;
    }
  };

  return (
    <main data-ready={mounted ? 'true' : undefined} style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>ZIP harness</h1>
      <p id="log">{log}</p>
      <button id="run-stream" onClick={() => runStreaming(3)}>stream 3</button>{' '}
      <button id="run-buffered" onClick={() => runBuffered(3)}>buffered 3</button>{' '}
      <button id="run-stream-0" onClick={() => runStreaming(0)}>stream 0</button>
    </main>
  );
}
