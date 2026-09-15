import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const MIGRATION = 'supabase/migrations/20260912170000_certificate_settings_and_purge_receipts.sql';

test('the booklet and the protocol are drawn from one settings row that browsers never read directly', async () => {
  const [migration, settings, route, image] = await Promise.all([
    read(MIGRATION),
    read('server/certificates/settings.ts'),
    read('app/api/admin/settings/certificate/route.ts'),
    read('app/certificate-assets/image/route.ts'),
  ]);
  assert.match(migration, /create table public\.certificate_settings/u);
  assert.match(migration, /singleton boolean primary key default true check \(singleton\)/u);
  assert.match(migration, /organization_name text not null default 'SafetyHub'/u);
  assert.match(
    migration,
    /revoke all on public\.certificate_settings from public, anon, authenticated/u,
  );
  assert.match(migration, /private\.require_capability\('site\.settings\.manage'\)/u);
  assert.match(migration, /message = 'CERTIFICATE_SETTINGS_VERSION_CONFLICT'/u);
  // Image bytes reach only the server; an administrator session gets flags.
  assert.match(migration, /return private\.certificate_settings_payload\(false\)/u);
  // The route authorizes before it reads a 2 MB body, and refuses bad PNGs.
  assert.match(
    route,
    /await requireCapability\('site\.settings\.manage'\);[\s\S]*?readJsonBody\(request, PATCH_BODY_LIMIT\)/u,
  );
  assert.match(route, /consumeAdminMutationQuota\(\s*'site\.settings\.update'/u);
  assert.match(route, /CERTIFICATE_IMAGE_INVALID/u);
  assert.match(settings, /const PNG_MAGIC = \[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a\]/u);
  assert.match(settings, /CERTIFICATE_IMAGE_MAX_BYTES = 400 \* 1024/u);
  // The stamp and signatures are served to signed-in sessions only, keyed by
  // the settings version so a replaced image is never reused from cache.
  assert.match(image, /requireUser\(\{ enforceLegal: false \}\)/u);
  assert.match(image, /status: 401/u);
  assert.match(image, /String\(settings\.version\) !== version/u);
  assert.match(image, /'Cache-Control': 'private, max-age=31536000, immutable'/u);
});

test('every certificate is a two-sided booklet drawn with the current settings', async () => {
  const [contract, renderer, server, exportHelper, metadataRoute, sample] = await Promise.all([
    read('lib/pdf/certificate-client-contract.ts'),
    read('lib/pdf/certificate-renderer.ts'),
    read('server/certificates/issuance.ts'),
    read('server/admin/certificate-export-archive.ts'),
    read('app/api/certificates/[certificateId]/metadata/route.ts'),
    read('app/api/admin/settings/certificate/sample/route.ts'),
  ]);
  assert.match(contract, /export type CertificateBranding = Readonly<\{/u);
  assert.match(contract, /assertCertificateBranding\(item\.branding\)/u);
  assert.match(
    contract,
    /SAFE_IMAGE_PATH_PATTERN =\s*\/\^\\\/certificate-assets\\\/image\\\?kind=\(\?:stamp\|chairman\|member\)&v=\[0-9\]\{1,12\}\$\/u/u,
  );
  // Two A5 landscape sides, the paper form's bilingual labels, no template PDF.
  assert.match(renderer, /insertWidthCm \* 72 \/ 2\.54/u);
  // Actual two-page output is exercised by document-editor.test.mjs.
  assert.match(renderer, /pdf\.addPage\(\[half \* 2, 375\]\)/u);
  assert.match(renderer, /const right = half \+ margin/u);
  assert.match(renderer, /КУӘЛІК \/ УДОСТОВЕРЕНИЕ №/u);
  assert.match(renderer, /Білімін тексеру туралы мәліметтер/u);
  assert.match(renderer, /Председатель/u);
  assert.doesNotMatch(renderer, /templateBytes|PDFDocument\.load\(/u);
  assert.match(renderer, /documentStatement\(text, branding, metadata.titleSnapshot\)/u);
  // The server copies the branding into each certificate's metadata.
  assert.match(server, /branding: CertificateBranding,/u);
  assert.match(exportHelper, /const branding = await loadCertificateBranding\(\);/u);
  assert.match(metadataRoute, /await loadCertificateBranding\(\)/u);
  assert.match(sample, /requireCapability\('site\.settings\.manage'\)/u);
  assert.match(
    sample,
    /createCertificateVerificationToken\('00000000-0000-4000-8000-000000000000'\)/u,
  );
});

test('an export carries the workbook, one protocol per company and course, then the certificates', async () => {
  const [protocol, worker, client] = await Promise.all([
    read('lib/pdf/protocol-renderer.ts'),
    read('lib/pdf/certificate.worker.ts'),
    read('lib/pdf/certificate-client.ts'),
  ]);
  assert.match(protocol, /export function groupItemsForProtocols/u);
  assert.match(protocol, /return `protocols\/Протокол-/u);
  assert.match(protocol, /заседания комиссии по проверке знаний/u);
  assert.match(protocol, /Результат сдачи экзаменов/u);
  assert.match(protocol, /participantResult\(person\)/u);
  assert.doesNotMatch(protocol, /drawSignature|drawImage/u);
  assert.doesNotMatch(protocol, /node:(?:fs|path|crypto)|SafetyHub\.kz/u);
  for (const source of [worker, client]) {
    const report = source.indexOf('CERTIFICATE_REPORT_FILENAME');
    const protocols = source.indexOf('groupItemsForProtocols(metadata.items)');
    const certificates = source.indexOf('name: `certificates/');
    assert.ok(report >= 0 && report < protocols && protocols < certificates);
  }
});

test('the directory can delete an account that never took a test', async () => {
  const [directory, button, migration] = await Promise.all([
    read('app/(admin)/admin/employees/directory/page.tsx'),
    read('components/admin/account-purge-button.tsx'),
    read(MIGRATION),
  ]);
  assert.match(directory, /const canDeleteUser = actor\.capabilities\.includes\('user\.delete'\)/u);
  assert.match(directory, /<AccountPurgeButton userId=\{user\.id\} label=\{user\.label\} \/>/u);
  assert.match(button, /confirmation: 'УДАЛИТЬ'/u);
  assert.match(button, /reason: trimmed/u);
  assert.match(button, /trimmed\.length < 10/u);
  // The author of the initial course import is no longer undeletable.
  assert.match(migration, /alter column created_by drop not null/u);
  assert.match(migration, /references auth\.users\(id\) on delete set null/u);
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('create or replace function private.purge_user_account_immediate'),
    ),
    /ACCOUNT_HAS_IMPORT_RECEIPT/u,
  );
});
