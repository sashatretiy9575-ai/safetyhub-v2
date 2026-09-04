import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  assertCertificateExportMetadata,
  assertCertificateRenderMetadata,
} from '../../lib/pdf/certificate-client-contract.ts';
import { generateCertificateInBrowser } from '../../lib/pdf/certificate-renderer.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const validCertificate = {
  schemaVersion: 1,
  certificateId: '5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e',
  filename: 'SH-2026-ABC-Айжан.pdf',
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

test('authorized certificate metadata is bounded and precedes browser-only rendering', async () => {
  const [route, helper, server] = await Promise.all([
    read('app/api/certificates/[certificateId]/metadata/route.ts'),
    read('features/certificates/metadata-response.ts'),
    read('features/certificates/server.ts'),
  ]);
  const auth = route.indexOf('const auth = await requireUser()');
  const certificate = route.indexOf('getCertificateDownloadPayload(certificateId)');
  const metadata = route.indexOf('createCertificateRenderMetadata(data, getSiteUrl())');

  assert.ok(auth >= 0 && auth < certificate && certificate < metadata);
  assert.match(route, /requireCapability\('certificate\.read'/);
  // Revocation is no longer a product state: a superseded certificate resolves
  // to its replacement in the database, so the route only guards a missing one.
  assert.match(route, /if \(!data\) {/);
  assert.match(route, /createBoundedCertificateMetadataResponse/);
  assert.match(helper, /CERTIFICATE_METADATA_MAX_BYTES = 32 \* 1024/);
  assert.match(helper, /CERTIFICATE_EXPORT_METADATA_MAX_BYTES = 2 \* 1024 \* 1024/);
  assert.match(helper, /'Cache-Control': 'private, no-store'/);
  assert.match(server, /value === null \|\| value === undefined \? 'ru'/);
  assert.match(server, /titleSnapshot: boundedText\(240\)\.nullable\(\)\.optional\(\)/);
  assert.match(server, /titleSnapshot: value\.titleSnapshot \?\? value\.testTitle/);
  assert.doesNotMatch(route, /pdf-lib|qrcode|application\/pdf|generateCertificate/);
});

test('legacy backend PDF endpoint returns a stable client-only contract', async () => {
  const route = await read('app/api/certificates/[certificateId]/route.ts');
  assert.match(route, /requireUser\(\)/);
  assert.match(route, /getCertificateDownloadPayload\(certificateId\)/);
  assert.match(route, /CERTIFICATE_PDF_CLIENT_ONLY/);
  assert.match(route, /metadataUrl/);
  assert.match(route, /status: 409/);
  assert.doesNotMatch(route, /application\/pdf|Content-Disposition|pdf-lib|generateCertificate/);
});

test('worker graph dynamically loads heavy libraries and contains no Node runtime imports', async () => {
  const [client, worker, renderer, report, archive] = await Promise.all([
    read('lib/pdf/certificate-client.ts'),
    read('lib/pdf/certificate.worker.ts'),
    read('lib/pdf/certificate-renderer.ts'),
    read('lib/pdf/certificate-report.ts'),
    read('lib/pdf/certificate-archive.ts'),
  ]);
  assert.match(client, /new Worker\(new URL\('\.\/certificate\.worker\.ts', import\.meta\.url\)/);
  assert.match(renderer, /import\('pdf-lib'\)/);
  assert.match(renderer, /import\('qrcode'\)/);
  assert.match(renderer, /import\('@pdf-lib\/fontkit'\)/);
  assert.match(archive, /import\('fflate'\)/);
  assert.match(worker, /CERTIFICATE_RENDER_CONCURRENCY/);
  assert.match(worker, /type: 'progress'/);
  assert.match(worker, /type: 'cancel'/);
  assert.match(renderer, /MAX_FONT_BYTES = 24 \* 1024 \* 1024/);
  assert.doesNotMatch(
    `${client}\n${worker}\n${renderer}\n${report}\n${archive}`,
    /node:(?:fs|path|crypto)/,
  );
});

test('client metadata rejects oversized or unsafe render/export payloads', () => {
  assert.doesNotThrow(() => assertCertificateRenderMetadata(validCertificate));
  assert.doesNotThrow(() =>
    assertCertificateRenderMetadata({
      ...validCertificate,
      locale: 'kk',
      fontUrl: '/certificate-assets/font?locale=kk&v=1',
    }),
  );
  assert.doesNotThrow(() =>
    assertCertificateRenderMetadata({
      ...validCertificate,
      locale: 'en',
      fontUrl: '/certificate-assets/font?locale=en&v=1',
    }),
  );
  assert.throws(
    () => assertCertificateRenderMetadata({ ...validCertificate, titleSnapshot: 'x'.repeat(241) }),
    /CERTIFICATE_TITLE_INVALID/,
  );
  assert.throws(
    () =>
      assertCertificateRenderMetadata({
        ...validCertificate,
        fontUrl: 'https://evil.invalid/font',
      }),
    /CERTIFICATE_ASSET_URL_INVALID/,
  );
  const validExport = {
    schemaVersion: 1,
    filename: 'safetyhub-certificates-2026-09-01.zip',
    generatedAt: '2026-09-01T10:00:00.000Z',
    requested: 1,
    total: 1,
    eligible: 1,
    reportFontUrl: '/certificate-assets/font?locale=ru&v=1',
    skipped: [],
    items: [validCertificate],
    archivePolicy: {
      maxItemsPerBufferedArchive: 100,
      maxItems: 500,
      renderConcurrency: 2,
    },
  };
  assert.doesNotThrow(() => assertCertificateExportMetadata(validExport));
  assert.throws(
    () => assertCertificateExportMetadata({ ...validExport, eligible: 2 }),
    /CERTIFICATE_EXPORT_COUNT_INVALID/,
  );
});

test('browser renderer produces a valid one-page PDF from fetched immutable assets', async () => {
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
  }
});

test('browser renderer embeds the full pinned CJK font for a Chinese identity and course', async () => {
  const zhCertificate = {
    ...validCertificate,
    filename: 'SH-2026-ZH-张伟.pdf',
    locale: 'zh',
    titleSnapshot: '工业安全与劳动保护',
    fontUrl: '/certificate-assets/font?locale=zh&v=Sans2.004',
    fullName: '张伟',
    position: '安全工程师',
    organization: '哈萨克斯坦安全技术有限公司',
    certificateNumber: 'SH-2026-ZH-001',
  };
  const [template, font] = await Promise.all([
    readFile(new URL('../../public/certificates/template-v1.pdf', import.meta.url)),
    readFile(new URL('../../lib/pdf/assets/NotoSansCJKsc-Regular-Sans2.004.otf', import.meta.url)),
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === zhCertificate.templateUrl) {
      return new Response(template, {
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(template.length) },
      });
    }
    if (url === zhCertificate.fontUrl) {
      return new Response(font, {
        headers: { 'Content-Type': 'font/otf', 'Content-Length': String(font.length) },
      });
    }
    return new Response('Not found', { status: 404 });
  };
  try {
    const bytes = await generateCertificateInBrowser(zhCertificate);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.match(pdf.getTitle() ?? '', /SH-2026-ZH-001/);
    assert.ok(bytes.byteLength < 2 * 1024 * 1024, `subset PDF is ${bytes.byteLength} bytes`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
