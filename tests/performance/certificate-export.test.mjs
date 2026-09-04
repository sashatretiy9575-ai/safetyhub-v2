import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import fontkit from '@pdf-lib/fontkit';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import {
  attachmentContentDisposition,
  certificateFilename,
  normalizePdfText,
} from '../../lib/pdf/certificate.ts';
import { createStreamingZipArchive, createZipArchive } from '../../lib/pdf/certificate-archive.ts';
import { generateCertificateReportInBrowser } from '../../lib/pdf/certificate-report.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('small export caps at one hundred while background jobs accept five hundred', async () => {
  const [route, jobs, helper] = await Promise.all([
    read('app/api/admin/attestations/export/route.ts'),
    read('app/api/admin/attestations/export-jobs/route.ts'),
    read('features/admin/certificate-export-archive.ts'),
  ]);
  assert.match(route, /attestationIds:[\s\S]*\.min\(1\)[\s\S]*\.max\(100\)/);
  assert.match(route, /DUPLICATE_ATTESTATION_IDS/);
  assert.match(jobs, /attestationIds:[\s\S]*\.min\(1\)[\s\S]*\.max\(500\)/);
  assert.match(jobs, /create_certificate_export_job/);
  assert.match(helper, /items: z\.array\(certificateDownloadPayloadSchema\)\.max\(500\)/);
  assert.match(route, /requireCapability\('results\.export'/);
  assert.match(route, /requireCapability\('certificate\.read'\)/);
});

test('export revalidates the full selection in one actor-bound RPC', async () => {
  const [route, hardening] = await Promise.all([
    read('app/api/admin/attestations/export/route.ts'),
    read('supabase/migrations/20260813030000_security_hardening_followup.sql'),
  ]);
  assert.match(route, /client\.rpc\('resolve_certificate_export'/);
  assert.match(route, /p_attestation_ids: parsed\.data\.attestationIds/);
  assert.doesNotMatch(route, /\.from\('test_attempts'\)|\.from\('certificates'\)/);
  assert.doesNotMatch(route, /NO_ACTIVE_CERTIFICATES/);
  assert.match(route, /consumeCoarseQuota\('certificate\.export'/);
  assert.doesNotMatch(route, /consumeBusinessQuota/);
  assert.match(
    hardening,
    /resolve_certificate_export[\s\S]*private\.enforce_actor_quota\('certificate\.export'\)/,
  );
  assert.match(route, /createBoundedCertificateMetadataResponse/);
});

test('report-only ZIP input creates one informative PDF page', async () => {
  const report = await read('lib/pdf/certificate-report.ts');
  assert.match(report, /sourceRows\.length > 500/);
  assert.match(report, /Math\.max\(1, Math\.ceil\(rows\.length \/ rowsPerPage\)\)/);
  assert.match(report, /Действующих сертификатов в выбранных строках нет/);

  const archive = await createZipArchive([
    { name: 'report.pdf', bytes: new TextEncoder().encode('%PDF-empty-report') },
  ]);
  const unpacked = unzipSync(archive);
  assert.deepEqual(Object.keys(unpacked), ['report.pdf']);
  assert.equal(new TextDecoder().decode(unpacked['report.pdf']), '%PDF-empty-report');
});

test('browser report renderer creates a valid PDF without server filesystem access', async () => {
  const fontBytes = await readFile(
    new URL('../../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url),
  );
  const createdAt = new Date('2026-09-01T10:00:00.000Z');
  const bytes = await generateCertificateReportInBrowser(
    [
      {
        fullName: 'Әділ Құсайынұлы',
        position: 'Инженер',
        organization: 'SafetyHub',
        courseTitle: 'Безопасность и охрана труда',
        score: 10,
        total: 10,
        completedAt: createdAt,
        issuedAt: createdAt,
        certificateNumber: 'SH-2026-ABCDEF123456',
      },
    ],
    createdAt,
    fontBytes,
  );
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.match(pdf.getTitle() ?? '', /SafetyHub\.kz/);
});

test('report geometry preserves every canonical certificate number without ellipsis', async () => {
  const report = await read('lib/pdf/certificate-report.ts');
  const columns = report.match(/const COLUMNS: readonly Column\[\] = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(columns, 'expected the report column definition');
  const widths = [...columns.matchAll(/\bwidth: (\d+)/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 8);
  assert.ok(widths.reduce((total, width) => total + width, 0) <= 841.89 - 32 * 2);

  const certificateWidth = Number(
    columns.match(
      /label: '№ сертификата', width: (\d+), value: \(row\) => row\.certificateNumber/,
    )?.[1],
  );
  assert.ok(Number.isFinite(certificateWidth));

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontBytes = await readFile(
    new URL('../../lib/pdf/assets/noto-sans-latin-cyrillic.ttf', import.meta.url),
  );
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const widestHex = Array.from('0123456789ABCDEF').reduce((widest, candidate) =>
    font.widthOfTextAtSize(candidate, 8) > font.widthOfTextAtSize(widest, 8) ? candidate : widest,
  );
  const values = ['SH-2026-0376EB71EF71', `SH-2026-${widestHex.repeat(12)}`];
  for (const value of values) {
    assert.ok(
      font.widthOfTextAtSize(value, 8) <= certificateWidth - 12,
      `${value} must fit the report cell at 8pt`,
    );
  }
});

test('server returns export metadata while the browser worker creates reports and archives', async () => {
  const [route, exportHelper, report, archive, certificateRoute, worker, client] =
    await Promise.all([
      read('app/api/admin/attestations/export/route.ts'),
      read('features/admin/certificate-export-archive.ts'),
      read('lib/pdf/certificate-report.ts'),
      read('lib/pdf/certificate-archive.ts'),
      read('app/api/certificates/[certificateId]/route.ts'),
      read('lib/pdf/certificate.worker.ts'),
      read('lib/pdf/certificate-client.ts'),
    ]);

  assert.match(route, /createCertificateExportMetadata/);
  assert.match(route, /CERTIFICATE_EXPORT_METADATA_MAX_BYTES/);
  assert.doesNotMatch(route, /application\/zip|createStreamingZipArchive|generateCertificate/);
  assert.match(exportHelper, /createCertificateRenderMetadata/);
  assert.match(exportHelper, /archivePolicy/);
  assert.match(worker, /name: 'report\.pdf'/);
  assert.match(worker, /name: `certificates\//);
  assert.match(worker, /createStreamingZipArchive/);
  assert.match(client, /CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS/);
  assert.match(client, /showSaveFilePicker/);
  assert.match(client, /stream: true/);
  assert.match(client, /type: 'chunk-ack'/);
  assert.match(worker, /waitForChunkAcknowledgement/);
  assert.match(worker, /await acknowledged/);
  assert.match(report, /Отчёт по выданным сертификатам/);
  assert.match(report, /rowsPerPage/);
  assert.match(report, /Страница \$\{pageIndex \+ 1\} из \$\{pageCount\}/);
  assert.match(report, /label: '№ сертификата', width: 117/);
  assert.match(report, /fixed `SH-YYYY-XXXXXXXXXXXX` shape/);
  assert.match(archive, /ZipPassThrough/);
  assert.match(archive, /controller\.desiredSize/);
  assert.match(archive, /highWaterMark: 1024 \* 1024/);
  assert.match(archive, /pull\(\)/);
  assert.doesNotMatch(route, /\.storage\.|pdf_projection|pdf_base64/);
  assert.doesNotMatch(certificateRoute, /pdf_projection|pdf_base64/);
});

test('certificate payload and filenames preserve multilingual participant data safely', async () => {
  const [certificate, renderer, assets] = await Promise.all([
    read('lib/pdf/certificate.ts'),
    read('lib/pdf/certificate-renderer.ts'),
    read('app/certificate-assets/font/route.ts'),
  ]);
  assert.match(certificate, /\.normalize\('NFC'\)/);
  assert.match(assets, /noto-sans-latin-cyrillic\.ttf/);
  assert.match(assets, /NotoSansCJKsc-Regular-Sans2\.004\.otf/);
  assert.match(assets, /CJK_FONT_BYTES = 16_437_364/);
  assert.match(assets, /2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b/);
  assert.match(assets, /fs\.readFile\(descriptor\.path\)/);
  assert.doesNotMatch(assets, /fetch\(|raw\.githubusercontent|upstream/);
  assert.match(renderer, /organization: 'Компания'/);
  assert.match(renderer, /passScore: \(score, total\) => `Проходной балл:/);
  assert.match(renderer, /heading: '证书'/);
  assert.match(certificate, /filename\*=UTF-8''/);
  assert.match(certificate, /certificateFilename/);
});

test('multilingual attachment names are NFC-normalized and header-safe', () => {
  assert.equal(normalizePdfText('Әділ  Құсаи\u0306ынұлы'), 'Әділ Құсайынұлы');
  const filename = certificateFilename('SH-2026/..', 'Әділ\r\n Құсайынұлы');
  assert.equal(filename, 'SH-2026-Әділ-Құсайынұлы.pdf');
  const disposition = attachmentContentDisposition(filename);
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]+";/);
  assert.match(disposition, /filename\*=UTF-8''SH-2026-/);
  assert.doesNotMatch(disposition, /[\r\n]/);
});

test('streaming ZIP builder preserves Unicode names and rejects traversal', async () => {
  const archive = await createZipArchive([
    { name: 'report.pdf', bytes: new Uint8Array([1, 2, 3]) },
    {
      name: 'certificates/SH-2026-1-Әділ-Құсайынұлы.pdf',
      bytes: new Uint8Array([4, 5, 6]),
    },
  ]);
  const unpacked = unzipSync(archive);
  assert.deepEqual([...unpacked['report.pdf']], [1, 2, 3]);
  assert.deepEqual([...unpacked['certificates/SH-2026-1-Әділ-Құсайынұлы.pdf']], [4, 5, 6]);
  await assert.rejects(
    createZipArchive([
      { name: 'report.pdf', bytes: new Uint8Array([1]) },
      { name: '../secret.pdf', bytes: new Uint8Array([2]) },
    ]),
    /CERTIFICATE_ARCHIVE_ENTRY_INVALID/,
  );
  for (const name of [
    '..',
    'certificates/..',
    '/absolute.pdf',
    'C:/drive.pdf',
    'a\\b.pdf',
    'a/./b.pdf',
  ]) {
    await assert.rejects(
      createZipArchive([
        { name: 'report.pdf', bytes: new Uint8Array([1]) },
        { name, bytes: new Uint8Array([2]) },
      ]),
      /CERTIFICATE_ARCHIVE_ENTRY_INVALID/,
    );
  }
  await assert.rejects(
    createZipArchive([
      { name: 'report.pdf', bytes: new Uint8Array([1]) },
      { name: 'REPORT.PDF', bytes: new Uint8Array([2]) },
    ]),
    /CERTIFICATE_ARCHIVE_ENTRY_INVALID/,
  );
});

test('streaming ZIP rejects oversized individual and cumulative output', async () => {
  await assert.rejects(
    createZipArchive([{ name: 'report.pdf', bytes: new Uint8Array(16 * 1024 * 1024 + 1) }]),
    /CERTIFICATE_ARCHIVE_BYTES_INVALID/,
  );

  const source = await read('lib/pdf/certificate-archive.ts');
  assert.match(source, /MAX_ARCHIVE_ENTRIES = 501/);
  assert.match(source, /MAX_ARCHIVE_TOTAL_BYTES = 512 \* 1024 \* 1024/);
  assert.match(source, /totalBytes \+ bytes\.byteLength > MAX_ARCHIVE_TOTAL_BYTES/);
});

test('streaming ZIP delivers an archive larger than the buffered Vercel response limit', async () => {
  async function* entries() {
    yield { name: 'report.pdf', bytes: new Uint8Array(80_000).fill(1) };
    for (let index = 0; index < 80; index += 1) {
      yield {
        name: `certificates/SH-LARGE-${index}.pdf`,
        bytes: new Uint8Array(60_000).fill((index % 251) + 1),
      };
    }
  }
  const reader = (await createStreamingZipArchive(entries())).getReader();
  let total = 0;
  let chunks = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks += 1;
  }
  assert.ok(total > 4_500_000, `expected >4.5MB, received ${total}`);
  assert.ok(chunks > 2, `expected a streamed response, received ${chunks} chunks`);
});
