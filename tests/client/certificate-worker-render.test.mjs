import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { generateCertificateInBrowser } from '../../lib/pdf/certificate-renderer.ts';

const validCertificate = {
  schemaVersion: 1,
  certificateId: '5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e',
  filename: 'SH-2026-ABC-WorkerTest.pdf',
  locale: 'ru',
  templateVersion: 1,
  titleSnapshot: 'Безопасность и охрана труда',
  templateUrl: '/certificates/template-v1.pdf',
  fontUrl: '/certificate-assets/font?locale=ru&v=1',
  fullName: 'Айжан Құсайынқызы',
  position: 'Инженер',
  organization: 'SafetyHub',
  score: 10,
  total: 10,
  passScore: 7,
  certificateNumber: 'SH-2026-ABC',
  completedAt: '2026-08-31T10:00:00.000Z',
  issuedAt: '2026-08-31T10:01:00.000Z',
  verificationUrl:
    'https://safetyhub.kz/verify/v1.5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

test('certificate renderer operates without window/document canvas in Web Worker environment', async () => {
  // Ensure document and window are undefined (typical Web Worker global scope)
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  delete globalThis.document;
  delete globalThis.window;

  const [template, font] = await Promise.all([
    readFile(new URL('../../public/certificates/template-v1.pdf', import.meta.url)),
    readFile(new URL('../../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url)),
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === validCertificate.templateUrl) {
      return new Response(template, {
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(template.length) },
      });
    }
    if (url === validCertificate.fontUrl) {
      return new Response(font, {
        headers: { 'Content-Type': 'font/ttf', 'Content-Length': String(font.length) },
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const bytes = await generateCertificateInBrowser(validCertificate);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.match(pdf.getTitle() ?? '', /SH-2026-ABC/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDocument !== undefined) globalThis.document = previousDocument;
    if (previousWindow !== undefined) globalThis.window = previousWindow;
  }
});
