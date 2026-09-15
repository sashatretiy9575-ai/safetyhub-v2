import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { generateCertificateInBrowser } from '../../lib/pdf/certificate-renderer.ts';

const branding = {
  documentDefaults: { reviewerName: 'Иванов', commission: [], companyName: '', programName: '', protocolText: '', insertWidthCm: 32, insertHeightCm: 10 },
  organizationName: 'ТОО «Пример»',
  bin: '123456789012',
  chairmanName: 'Иванов И. И.',
  chairmanPosition: 'Директор SafetyHub',
  memberName: 'Петров П. П.',
  memberPosition: 'Преподаватель SafetyHub',
  secondMemberName: 'Сидоров С. С.',
  secondMemberPosition: 'Преподаватель SafetyHub',
  protocolNumber: '7',
  validityMonths: 12,
  examTextKk: '№{protocol} хаттама негіздемесі бойынша емтихан тапсырды',
  examTextRu: 'сдал экзамен на основании протокола №{protocol}',
  knowledgeTextKk: 'өрт қауіпсіздігі бойынша емтихан тапсырды',
  knowledgeTextRu: 'сдал экзамен по пожарной безопасности',
  stampUrl: null,
  chairmanSignatureUrl: null,
  memberSignatureUrl: null,
};

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
  branding,
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
    if (url.includes('/certificate-assets/font')) {
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

test('photo is embedded in the same single sheet and transport errors never produce an incomplete download', async () => {
  const sharp = (await import('sharp')).default;
  const photo = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#456789' } }).jpeg().toBuffer();
  const font = await readFile(new URL('../../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url));
  const previous = globalThis.fetch;
  const photoUrl = `/api/certificates/${validCertificate.certificateId}/photo`;
  let fail = false, requested = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === photoUrl) {
      requested++;
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      return fail ? new Response(null, { status: 503 }) : new Response(photo);
    }
    return new Response(font);
  };
  try {
    const bytes = await generateCertificateInBrowser({ ...validCertificate, photoUrl });
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - 32 * 72 / 2.54) < .01);
    assert.ok(Math.abs(pdf.getPage(0).getHeight() - 10 * 72 / 2.54) < .01);
    const { PDFName } = await import('pdf-lib');
    assert.ok(pdf.getPage(0).node.Resources().lookup(PDFName.of('XObject')).keys().length > 0);
    fail = true;
    await assert.rejects(generateCertificateInBrowser({ ...validCertificate, photoUrl }), /CERTIFICATE_PHOTO_UNAVAILABLE/);
    assert.equal(requested, 2, 'a profile photo must not be reused from the font cache');
    await assert.rejects(generateCertificateInBrowser({ ...validCertificate, branding: { ...branding, documentDefaults: undefined } }), /INSERT_SIZE_REQUIRED/);
  } finally { globalThis.fetch = previous; }
});
