import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('certificate uses a prepared Latin, Cyrillic and Kazakh subset with a byte-bounded cache', async () => {
  const source = await read('lib/pdf/certificate.ts');

  assert.match(source, /CERTIFICATE_STATIC_ASSETS = Promise\.all/);
  assert.match(source, /embedFont\(fontBytes, \{ subset: false \}\)/);
  assert.match(source, /noto-sans-latin-cyrillic\.ttf/);
  assert.match(source, /PDF_CACHE_MAX_ENTRIES = 16/);
  assert.match(source, /PDF_CACHE_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.match(source, /pdfInFlight/);
});

test('downloads generate immutable PDFs in bounded memory after authorization', async () => {
  const route = await read('app/api/certificates/[certificateId]/route.ts');

  const auth = route.indexOf('const auth = await requireUser()');
  const certificate = route.indexOf('getCertificateDownloadPayload(certificateId)');
  const generation = route.indexOf('generateCertificateCached(');

  assert.ok(auth >= 0 && auth < certificate);
  assert.ok(certificate < generation);
  assert.doesNotMatch(route, /certificate_pdf_projection/);
  assert.match(route, /certificatePdfFingerprint/);
  assert.match(route, /attachmentContentDisposition/);
  assert.match(route, /data\.revokedAt/);
  assert.match(route, /Cache-Control': 'private, no-store'/);
});
