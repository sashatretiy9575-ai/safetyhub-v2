import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { unzipSync } from 'fflate';
import {
  attachmentContentDisposition,
  certificateFilename,
  normalizePdfText,
} from '../../lib/pdf/certificate.ts';
import { createStreamingZipArchive, createZipArchive } from '../../lib/pdf/certificate-archive.ts';
import {
  CERTIFICATE_REPORT_FILENAME,
  generateCertificateReportWorkbook,
} from '../../lib/pdf/certificate-report-xlsx.ts';
import {
  CERTIFICATE_EXPORT_JOB_LIMIT,
  CERTIFICATE_EXPORT_SYNC_LIMIT,
} from '../../lib/constants.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('small export caps at one hundred while background jobs accept five hundred', async () => {
  const [route, jobs, helper] = await Promise.all([
    read('app/api/admin/attestations/export/route.ts'),
    read('app/api/admin/attestations/export-jobs/route.ts'),
    read('features/admin/certificate-export-archive.ts'),
  ]);
  // The numbers themselves are asserted against `lib/constants.ts`, so a change
  // to either ceiling has to be a deliberate one rather than a stray literal.
  assert.equal(CERTIFICATE_EXPORT_SYNC_LIMIT, 100);
  assert.equal(CERTIFICATE_EXPORT_JOB_LIMIT, 500);
  assert.match(
    route,
    /attestationIds:[\s\S]*\.min\(1\)[\s\S]*\.max\(CERTIFICATE_EXPORT_SYNC_LIMIT\)/,
  );
  assert.match(route, /DUPLICATE_ATTESTATION_IDS/);
  assert.match(
    jobs,
    /attestationIds:[\s\S]*\.min\(1\)[\s\S]*\.max\(CERTIFICATE_EXPORT_JOB_LIMIT\)/,
  );
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

test('the list that travels with the certificates is a workbook, not a PDF table', async () => {
  const report = await read('lib/pdf/certificate-report-xlsx.ts');
  assert.match(report, /sourceRows\.length > MAX_ROWS/);
  assert.match(report, /Действующих удостоверений в выбранных строках нет/);
  assert.match(report, /CERTIFICATE_REPORT_FILENAME = 'report\.xlsx'/);
  assert.doesNotMatch(report, /pdf-lib|node:(?:fs|path|crypto)/);
  const columns = report.match(/const COLUMNS: readonly Column\[\] = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(columns, 'expected the workbook column definition');
  assert.equal((columns.match(/label: '/g) ?? []).length, 10);
  assert.match(columns, /label: '№ удостоверения'/);
  assert.match(columns, /label: 'Действителен до'/);

  const archive = await createZipArchive([
    { name: CERTIFICATE_REPORT_FILENAME, bytes: new TextEncoder().encode('PK-empty-report') },
  ]);
  const unpacked = unzipSync(archive);
  assert.deepEqual(Object.keys(unpacked), ['report.xlsx']);
});

test('browser workbook writer creates a valid .xlsx without server filesystem access', async () => {
  const createdAt = new Date('2026-09-01T10:00:00.000Z');
  const bytes = await generateCertificateReportWorkbook(
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
        validUntil: new Date('2027-09-01T10:00:00.000Z'),
        certificateNumber: 'SH-2026-ABCDEF123456',
      },
      {
        fullName: '=HYPERLINK("x")',
        position: null,
        organization: null,
        courseTitle: 'Курс',
        score: 7,
        total: 10,
        completedAt: createdAt,
        issuedAt: createdAt,
        validUntil: null,
        certificateNumber: 'SH-2026-000000000001',
      },
    ],
    createdAt,
  );
  assert.equal(new TextDecoder().decode(bytes.slice(0, 2)), 'PK');
  const parts = unzipSync(bytes);
  assert.deepEqual(
    Object.keys(parts).sort(),
    [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ].sort(),
  );
  const sheet = new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']);
  assert.match(sheet, /Әділ Құсайынұлы/);
  assert.match(sheet, /SH-2026-ABCDEF123456/);
  assert.match(sheet, /01\.09\.2027/);
  // A formula-looking name is stored as text, never evaluated.
  assert.match(sheet, /'=HYPERLINK\(&quot;x&quot;\)/);
  assert.doesNotMatch(sheet, /<f>/);
});

test('server returns export metadata while the browser worker creates reports and archives', async () => {
  const [route, exportHelper, report, archive, certificateRoute, worker, client] =
    await Promise.all([
      read('app/api/admin/attestations/export/route.ts'),
      read('features/admin/certificate-export-archive.ts'),
      read('lib/pdf/certificate-report-xlsx.ts'),
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
  assert.match(worker, /name: CERTIFICATE_REPORT_FILENAME/);
  assert.match(worker, /name: `certificates\//);
  assert.match(worker, /createStreamingZipArchive/);
  assert.match(client, /CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS/);
  assert.match(client, /showSaveFilePicker/);
  assert.match(client, /groupCertificateExportByOrganization/);
  assert.match(client, /stream: true/);
  assert.match(client, /type: 'chunk-ack'/);
  assert.match(worker, /waitForChunkAcknowledgement/);
  assert.match(worker, /await acknowledged/);
  // The list is a workbook: one sheet, frozen header, every certificate number in full.
  assert.match(report, /Выданные удостоверения · SafetyHub ·/);
  assert.match(report, /state="frozen"/);
  assert.match(report, /label: '№ удостоверения', width: 24/);
  assert.match(report, /zipSync\(/);
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
  assert.match(assets, /NotoSansCJKsc-Regular-b2e9d66e\.otf/);
  assert.match(assets, /CJK_FONT_BYTES = 3_553_936/);
  assert.match(assets, /b2e9d66e497b1e69e5066b8bec9433d5026aa593918d4625a03555817047f993/);
  assert.match(assets, /fs\.readFile\(descriptor\.path\)/);
  assert.doesNotMatch(assets, /fetch\(|raw\.githubusercontent|upstream/);
  // The booklet's labels are the fixed bilingual form; the locale only picks
  // the font, so a Chinese name still renders with the CJK face.
  assert.match(renderer, /КУӘЛІК \/ УДОСТОВЕРЕНИЕ №/);
  assert.match(renderer, /Сведения о проверке знаний/);
  assert.match(renderer, /subset: metadata\.locale === 'zh'/);
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
