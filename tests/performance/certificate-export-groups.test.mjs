import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupCertificateExportByOrganization,
  organizationArchiveFilename,
  organizationArchiveKey,
  uniqueArchiveFilename,
} from '../../lib/pdf/certificate-export-groups.ts';
import { assertCertificateExportMetadata } from '../../lib/pdf/certificate-client-contract.ts';

// The same shape tests/performance/certificate-pdf.test.mjs accepts as valid.
const branding = {
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

const certificate = (index, organization) => ({
  schemaVersion: 1,
  certificateId: `5f0c6f0e-5f2d-4f69-8a2e-${String(index).padStart(12, '0')}`,
  filename: `SH-2026-${index}.pdf`,
  locale: 'ru',
  templateVersion: 1,
  titleSnapshot: 'Безопасность и охрана труда',
  templateUrl: '/certificates/template-v1.pdf',
  fontUrl: '/certificate-assets/font?locale=ru&v=1',
  fullName: `Сотрудник ${index}`,
  position: null,
  organization,
  score: 10,
  total: 10,
  passScore: 7,
  certificateNumber: `SH-2026-${index}`,
  completedAt: '2026-08-31T10:00:00.000Z',
  issuedAt: '2026-08-31T10:01:00.000Z',
  verificationUrl:
    'https://safetyhub.kz/verify/v1.5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  branding,
});

function exportOf(items, skipped = []) {
  return {
    schemaVersion: 1,
    filename: 'safetyhub-certificates-2026-09-01.zip',
    generatedAt: '2026-09-01T10:10:00.000Z',
    requested: items.length + skipped.length,
    total: items.length + skipped.length,
    eligible: items.length,
    reportFontUrl: '/certificate-assets/font?locale=ru&v=1',
    skipped,
    items,
    archivePolicy: { maxItemsPerBufferedArchive: 100, maxItems: 500, renderConcurrency: 2 },
  };
}

test('archives are grouped by normalized company in first-seen order', () => {
  const metadata = exportOf([
    certificate(1, 'ТОО Арман Строй'),
    certificate(2, 'ТОО Восток Энерго'),
    certificate(3, 'тоо  арман строй'),
    certificate(4, null),
  ]);
  const groups = groupCertificateExportByOrganization(metadata);
  assert.deepEqual(
    groups.map((group) => [
      group.organization,
      group.metadata.filename,
      group.metadata.items.length,
    ]),
    [
      ['ТОО Арман Строй', 'ТОО Арман Строй.zip', 2],
      ['ТОО Восток Энерго', 'ТОО Восток Энерго.zip', 1],
      [null, 'safetyhub-certificates-2026-09-01.zip', 1],
    ],
  );
  for (const group of groups) {
    assert.doesNotThrow(() => assertCertificateExportMetadata(group.metadata));
    assert.equal(group.metadata.requested, group.metadata.items.length);
    assert.deepEqual(group.metadata.skipped, []);
  }
  assert.equal(
    groups.reduce((sum, group) => sum + group.metadata.eligible, 0),
    metadata.eligible,
  );
});

test('a report-only export stays one archive under the server name', () => {
  const skipped = [{ attestationId: '0f1e2d3c-4b5a-4c6d-8e7f-000000000001', reason: 'NOT_ISSUED' }];
  const metadata = exportOf([], skipped);
  assert.deepEqual(groupCertificateExportByOrganization(metadata), [
    { key: '', organization: null, metadata },
  ]);
});

test('company names become archive names the contract accepts', () => {
  assert.equal(organizationArchiveFilename('ТОО «Арман Строй»'), 'ТОО «Арман Строй».zip');
  assert.equal(organizationArchiveFilename('Арман-Строй, ТОО'), 'Арман-Строй, ТОО.zip');
  assert.equal(organizationArchiveFilename(' A/B:C*?"<>|D '), 'ABCD.zip');
  assert.equal(organizationArchiveFilename('..hidden..'), 'hidden.zip');
  assert.equal(organizationArchiveFilename('   '), null);
  assert.equal(organizationArchiveFilename(null), null);
  const long = 'К'.repeat(130);
  const bounded = organizationArchiveFilename(long);
  assert.equal(Array.from(bounded).length, 104);
  assert.ok(bounded.endsWith('.zip'));
  for (const name of ['ТОО «Арман Строй».zip', bounded]) {
    assert.doesNotThrow(() =>
      assertCertificateExportMetadata({ ...exportOf([certificate(1, 'x')]), filename: name }),
    );
  }
});

test('colliding names are numbered case-insensitively', () => {
  const used = new Set();
  assert.equal(uniqueArchiveFilename('Компания.zip', used), 'Компания.zip');
  assert.equal(uniqueArchiveFilename('КОМПАНИЯ.zip', used), 'КОМПАНИЯ-2.zip');
  assert.equal(uniqueArchiveFilename('компания.zip', used), 'компания-3.zip');
  assert.equal(organizationArchiveKey('  ТОО   Арман  '), 'тоо арман');
  const groups = groupCertificateExportByOrganization(
    exportOf([certificate(1, 'A/B'), certificate(2, 'A\\B')]),
  );
  assert.deepEqual(
    groups.map((group) => group.metadata.filename),
    ['AB.zip', 'AB-2.zip'],
  );
});
