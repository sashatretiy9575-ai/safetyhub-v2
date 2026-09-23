import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import {
  SAMPLE_ORGANIZATION,
  protocolFontUrl,
  retryAfterSeconds,
  samplePreviewJob,
} from '../../lib/pdf/document-preview-job.ts';
import {
  generateCertificateInBrowser,
  generateCertificatePreview,
} from '../../lib/pdf/certificate-renderer.ts';

// Synthetic people and requisites only: this repository is public.
const branding = {
  protocolLayoutVersion: 2,
  documentDefaults: {
    reviewerName: 'Проверяющий П.П.',
    commission: [{ name: 'Член К.К.', position: 'Преподаватель' }],
    companyName: 'Компания образца',
    programName: 'Программа образца',
    protocolText: 'Проверка по программе «{program}»',
    insertWidthCm: 32,
    insertHeightCm: 10,
  },
  organizationName: 'ТОО «Пример»',
  bin: '000000000000',
  chairmanName: 'Председатель П.П.',
  chairmanPosition: 'Директор',
  memberName: '',
  memberPosition: '',
  secondMemberName: '',
  secondMemberPosition: '',
  protocolNumber: '20.09',
  protocolDate: '2026-09-20',
  validityMonths: 12,
  examTextKk: '№{protocol} хаттама',
  examTextRu: 'протокол №{protocol}',
  knowledgeTextKk: '«{program}» бағдарламасы',
  knowledgeTextRu: 'программа «{program}»',
  stampUrl: '/certificate-assets/image?kind=stamp&v=7',
  chairmanSignatureUrl: '/certificate-assets/image?kind=chairman&v=7',
  memberSignatureUrl: null,
  protocolSignatureUrl: '/certificate-assets/image?kind=protocol&v=7',
};
const CERTIFICATE_ID = '00000000-0000-4000-8000-0000000000a1';
const engineer = { fullName: 'Иванов Иван', position: 'Инженер', education: 'Высшее' };
const worker = { fullName: 'Петров Пётр', position: 'Слесарь', education: 'Среднее специальное' };
const metadata = {
  schemaVersion: 1,
  certificateId: CERTIFICATE_ID,
  filename: 'SH-TEST-1.pdf',
  locale: 'ru',
  templateVersion: 1,
  titleSnapshot: 'Работа на высоте',
  templateUrl: '/certificates/template-v1.pdf',
  fontUrl: '/certificate-assets/font?locale=ru&v=1',
  fullName: 'Участник Второй',
  photoUrl: `/api/certificates/${CERTIFICATE_ID}/photo`,
  position: 'Инженер',
  organization: 'Компания',
  score: 9,
  total: 10,
  passScore: 7,
  certificateNumber: 'SH-TEST-1',
  completedAt: '2026-09-01T10:00:00.000Z',
  issuedAt: '2026-09-01T10:01:00.000Z',
  verificationUrl: 'https://safetyhub.kz/verify/v1.test',
  branding: { ...branding, protocolNumber: '01.09', protocolDate: '2026-09-01' },
};
const job = (tab, patch = {}, person = engineer, program = 'Работа на высоте') =>
  samplePreviewJob(tab, { ...branding, ...patch }, program, person);

test('the preview is the document a course would print today for a sample person', () => {
  const booklet = job('certificate');
  assert.equal(booklet.kind, 'certificate');
  assert.equal(booklet.input.fullName, 'Иванов Иван');
  assert.equal(booklet.input.organization, SAMPLE_ORGANIZATION);
  assert.equal(booklet.input.certificateNumber, 'ПРЕДПРОСМОТР');
  assert.equal(booklet.input.photoUrl, null);
  assert.equal(booklet.input.issuedAt, '2026-09-20T12:00:00+05:00');
  assert.equal(booklet.input.branding.protocolNumber, '20.09');
  const protocol = job('protocol', {}, worker);
  assert.equal(protocol.kind, 'protocol');
  assert.equal(protocol.input.organization, SAMPLE_ORGANIZATION);
  assert.equal(protocol.input.date, '2026-09-20');
  assert.deepEqual(
    protocol.input.participants.map(({ fullName, position, education, status, score, total }) => ({
      fullName,
      position,
      education,
      status,
      score,
      total,
    })),
    [{ ...worker, status: 'passed', score: 10, total: 10 }],
  );
  assert.equal(protocol.fontUrl, '/certificate-assets/font?locale=ru&v=1');
  assert.equal(
    protocolFontUrl([{ fullName: '王伟' }]),
    '/certificate-assets/font?locale=zh&v=Sans2.005',
  );
});

test('a quota answer becomes seconds to wait', () => {
  assert.equal(retryAfterSeconds('40'), 40);
  assert.equal(retryAfterSeconds(' 7 '), 7);
  assert.equal(retryAfterSeconds('0'), 1);
  assert.equal(retryAfterSeconds(null), 60);
  assert.equal(retryAfterSeconds('soon', 15), 15);
  assert.equal(retryAfterSeconds('99999'), 3600);
  const now = Date.parse('2026-09-20T10:00:00Z');
  assert.equal(retryAfterSeconds('Sun, 20 Sep 2026 10:00:30 GMT', 60, now), 30);
  assert.equal(retryAfterSeconds('Sun, 20 Sep 2026 09:00:00 GMT', 60, now), 1);
});

test('a preview is drawn without the photo it could not get; a download never is', async () => {
  const sharp = (await import('sharp')).default;
  const photo = await sharp({
    create: { width: 30, height: 40, channels: 3, background: '#456789' },
  })
    .jpeg()
    .toBuffer();
  const asset = (name) => readFile(new URL('../../lib/pdf/assets/' + name, import.meta.url));
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const original = globalThis.fetch;
  let photoRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/photo')) {
      photoRequests++;
      return new Response(null, { status: 403 });
    }
    if (url.includes('/certificate-assets/image?')) return new Response(pixel);
    assert.match(url, /\/certificate-assets\/font\?/);
    return new Response(
      await asset(
        url.includes('face=serif')
          ? `NotoSerif-${url.includes('weight=bold') ? 'Bold' : 'Regular'}.ttf`
          : url.includes('face=sans')
            ? 'NotoSans-Bold.ttf'
            : 'noto-sans-latin-cyrillic.ttf',
      ),
    );
  };
  const images = (pdf) =>
    pdf.getPage(0).node.Resources().lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0;
  try {
    performance.clearMeasures();
    // F8: a 403 without `identity.read` used to turn the whole preview into «PDF не сформирован».
    const errors = [];
    const withoutPhoto = await generateCertificatePreview(metadata, undefined, {
      onPhotoError: (error) => errors.push(error),
    });
    assert.equal(
      images(await PDFDocument.load(withoutPhoto)),
      2,
      'the stamp and the signature only',
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /CERTIFICATE_PHOTO_UNAVAILABLE/);
    // The editor as it is today passes no options and gets the same preview.
    assert.equal(images(await PDFDocument.load(await generateCertificatePreview(metadata))), 2);
    assert.equal(photoRequests, 2);

    // F2: the session's loader replaces the download; the URL it is given is the one to evict.
    const asked = [];
    const withPhoto = await generateCertificatePreview(metadata, undefined, {
      loadPhoto: async (url, signal) => {
        asked.push([url, signal]);
        return new Uint8Array(photo);
      },
      onPhotoError: (error) => errors.push(error),
    });
    assert.deepEqual(asked, [[metadata.photoUrl, undefined]]);
    assert.equal(images(await PDFDocument.load(withPhoto)), 3);
    assert.equal(errors.length, 1);
    assert.equal(photoRequests, 2);
    // Bytes that are not a JPEG are a photo that did not load, not a preview that failed.
    await generateCertificatePreview(metadata, undefined, {
      loadPhoto: async () => new Uint8Array([1, 2, 3]),
      onPhotoError: (error) => errors.push(error),
    });
    assert.equal(errors.length, 2);

    // A cancelled job is cancelled, whatever the photo was doing at that moment.
    const controller = new AbortController();
    await assert.rejects(
      generateCertificatePreview(metadata, controller.signal, {
        loadPhoto: async () => {
          controller.abort();
          throw new DOMException('cancelled', 'AbortError');
        },
        onPhotoError: (error) => errors.push(error),
      }),
      { name: 'AbortError' },
    );
    assert.equal(errors.length, 2);

    // The downloaded document stays strict, and always asks the server for the photo.
    await assert.rejects(generateCertificateInBrowser(metadata), /CERTIFICATE_PHOTO_UNAVAILABLE/);
    assert.equal(photoRequests, 3);

    for (const name of ['doc:job', 'doc:fonts', 'doc:photo', 'doc:facsimiles', 'doc:save']) {
      assert.ok(performance.getEntriesByName(name, 'measure').length > 0, name);
    }
  } finally {
    globalThis.fetch = original;
    performance.clearMeasures();
  }
});
