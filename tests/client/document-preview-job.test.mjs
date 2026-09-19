import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import {
  abortableDelay,
  buildPreviewJob,
  createBytesCache,
  createSessionCache,
  isDiscreteChange,
  jobKey,
  protocolFontUrl,
  retryAfterSeconds,
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
const draftPerson = {
  userId: '00000000-0000-4000-8000-000000000001',
  fullName: 'Участник Первый',
  position: 'Инженер',
  education: 'Высшее',
  photoUrl: '/api/admin/documents/photo/00000000-0000-4000-8000-000000000001',
  status: 'passed',
  score: 9,
  total: 10,
  certificateId: null,
};
const issuedPerson = {
  ...draftPerson,
  userId: '00000000-0000-4000-8000-000000000002',
  fullName: 'Участник Второй',
  photoUrl: '/api/admin/documents/photo/00000000-0000-4000-8000-000000000002',
  certificateId: CERTIFICATE_ID,
};
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
const state = (patch = {}) => ({
  tab: 'certificate',
  loading: false,
  person: draftPerson,
  metadata: null,
  branding,
  program: 'Работа на высоте',
  organization: 'Компания',
  sampleOrganization: 'Компания образца',
  batch: { date: '2026-09-20' },
  participants: [draftPerson, issuedPerson],
  ...patch,
});

test('the job mirrors the editor: what is drawn, what is said instead, what is waited for', () => {
  assert.deepEqual(buildPreviewJob(state({ loading: true })), { kind: 'wait' });
  assert.deepEqual(buildPreviewJob(state({ loading: true, tab: 'protocol' })), { kind: 'wait' });
  assert.deepEqual(buildPreviewJob(state({ person: undefined })), {
    kind: 'message',
    text: 'Выберите компанию, программу и сотрудника',
  });
  // The caller words the size it refuses; nobody is asked for a size before a person is chosen.
  const sizeMessage = 'Общая ширина вкладыша: от 8 до 60 см';
  assert.deepEqual(buildPreviewJob(state({ sizeMessage })), { kind: 'message', text: sizeMessage });
  assert.equal(
    buildPreviewJob(state({ sizeMessage, person: null })).text.startsWith('Выберите'),
    true,
  );
  assert.equal(buildPreviewJob(state({ sizeMessage, tab: 'protocol' })).kind, 'protocol');

  // An issued certificate waits for its own snapshot, not for the previous employee's.
  assert.deepEqual(buildPreviewJob(state({ person: issuedPerson })), { kind: 'wait' });
  const foreign = { ...metadata, certificateId: '00000000-0000-4000-8000-0000000000b2' };
  assert.deepEqual(buildPreviewJob(state({ person: issuedPerson, metadata: foreign })), {
    kind: 'wait',
  });
  assert.deepEqual(
    buildPreviewJob(state({ person: issuedPerson, metadataMessage: 'Повторите через 40 с' })),
    { kind: 'message', text: 'Повторите через 40 с' },
  );
  const issued = buildPreviewJob(state({ person: issuedPerson, metadata }));
  assert.equal(issued.kind, 'certificate');
  assert.equal(
    issued.input,
    metadata,
    'the frozen snapshot itself, with nothing of the form in it',
  );
  // A snapshot left over from the previous employee never stands in for a draft.
  assert.equal(buildPreviewJob(state({ metadata })).input.certificateNumber, 'ПРЕДПРОСМОТР');

  const draft = buildPreviewJob(state());
  assert.deepEqual(draft, {
    kind: 'certificate',
    input: {
      schemaVersion: 1,
      filename: 'Предпросмотр.pdf',
      locale: 'ru',
      templateVersion: 1,
      templateUrl: '/certificate-assets/template',
      fontUrl: '/certificate-assets/font?locale=ru&v=1',
      fullName: 'Участник Первый',
      position: 'Инженер',
      organization: 'Компания',
      titleSnapshot: 'Работа на высоте',
      photoUrl: draftPerson.photoUrl,
      score: 9,
      total: 10,
      passScore: 0,
      certificateNumber: 'ПРЕДПРОСМОТР',
      completedAt: '2026-09-20',
      issuedAt: '2026-09-20T12:00:00+05:00',
      branding,
    },
  });
  assert.equal(
    buildPreviewJob(state({ person: { ...draftPerson, score: null, total: null } })).input.total,
    0,
  );

  const protocol = buildPreviewJob(state({ tab: 'protocol' }));
  assert.deepEqual(protocol, {
    kind: 'protocol',
    input: {
      organization: 'Компания',
      courseTitle: 'Работа на высоте',
      date: '2026-09-20',
      items: [],
      participants: [draftPerson, issuedPerson],
    },
    branding,
    fontUrl: '/certificate-assets/font?locale=ru&v=1',
  });
  assert.equal(
    buildPreviewJob(state({ tab: 'protocol', organization: '' })).input.organization,
    'Компания образца',
  );
  assert.equal(
    protocolFontUrl([{ fullName: '张伟' }]),
    '/certificate-assets/font?locale=zh&v=Sans2.005',
  );
});

test('a key is the arguments of the generator: nothing less and nothing else', () => {
  const typed = { ...branding, chairmanName: 'Председатель Н.Н.', protocolNumber: 'НОВЫЙ/1' };
  const issued = jobKey(buildPreviewJob(state({ person: issuedPerson, metadata })));
  // F1: every keystroke used to regenerate the identical PDF of an issued certificate.
  assert.equal(
    jobKey(
      buildPreviewJob(
        state({
          person: issuedPerson,
          metadata,
          branding: typed,
          program: 'Другая программа',
          organization: 'Другая компания',
          batch: { date: '2027-01-01' },
          participants: [],
        }),
      ),
    ),
    issued,
  );
  // A draft is drawn from the open fields, so each of them is in its key.
  const draft = jobKey(buildPreviewJob(state()));
  assert.notEqual(jobKey(buildPreviewJob(state({ branding: typed }))), draft);
  assert.notEqual(jobKey(buildPreviewJob(state({ batch: { date: '2026-09-21' } }))), draft);
  assert.notEqual(
    jobKey(buildPreviewJob(state({ person: { ...draftPerson, position: 'Мастер' } }))),
    draft,
  );
  // The protocol lists everybody: the chosen employee and a snapshot are not its business.
  const protocol = jobKey(buildPreviewJob(state({ tab: 'protocol' })));
  assert.equal(
    jobKey(buildPreviewJob(state({ tab: 'protocol', person: issuedPerson, metadata }))),
    protocol,
  );
  assert.equal(
    jobKey(buildPreviewJob(state({ tab: 'protocol', person: null, sizeMessage: 'x' }))),
    protocol,
  );
  assert.notEqual(jobKey(buildPreviewJob(state({ tab: 'protocol', branding: typed }))), protocol);
  assert.notEqual(
    jobKey(buildPreviewJob(state({ tab: 'protocol', participants: [draftPerson] }))),
    protocol,
  );
  // The same state asked twice is the same PDF: a key is a cache address.
  assert.equal(jobKey(buildPreviewJob(state())), draft);
  assert.deepEqual(Object.keys(JSON.parse(protocol)), ['kind', 'input', 'branding', 'fontUrl']);
  assert.deepEqual(Object.keys(JSON.parse(issued)), ['kind', 'input']);
});

test('a choice is drawn at once, typing waits for a pause', () => {
  const draft = buildPreviewJob(state());
  const protocol = buildPreviewJob(state({ tab: 'protocol' }));
  const type = (patch) => ({ ...branding, ...patch });
  // Typing: requisites, texts, the insert size, the date and the number, the sample names.
  for (const next of [
    state({ branding: type({ chairmanName: 'Председатель Н.' }) }),
    state({ branding: type({ examTextRu: 'сдал экзамен' }) }),
    state({
      branding: type({ protocolNumber: '21.09', protocolDate: '2026-09-21' }),
      batch: { date: '2026-09-21' },
    }),
    state({ branding: type({ validityMonths: 24 }) }),
    state({
      branding: type({
        documentDefaults: { ...branding.documentDefaults, insertWidthCm: 30, commission: [] },
      }),
    }),
    state({ program: 'Программа образца 2' }),
  ]) {
    assert.equal(isDiscreteChange(draft, buildPreviewJob(next)), false);
    assert.equal(
      isDiscreteChange(protocol, buildPreviewJob({ ...next, tab: 'protocol', organization: '' })),
      false,
    );
  }
  // Choices: the first job, a tab, an employee, a company's people, a picture, a profile.
  assert.equal(isDiscreteChange(null, draft), true);
  assert.equal(isDiscreteChange(draft, protocol), true);
  assert.equal(isDiscreteChange(protocol, draft), true);
  assert.equal(
    isDiscreteChange(
      draft,
      buildPreviewJob(state({ person: { ...draftPerson, fullName: 'Участник Третий' } })),
    ),
    true,
  );
  assert.equal(
    isDiscreteChange(draft, buildPreviewJob(state({ person: { ...draftPerson, photoUrl: null } }))),
    true,
  );
  assert.equal(
    isDiscreteChange(draft, buildPreviewJob(state({ person: issuedPerson, metadata }))),
    true,
  );
  assert.equal(
    isDiscreteChange(
      protocol,
      buildPreviewJob(state({ tab: 'protocol', participants: [issuedPerson] })),
    ),
    true,
  );
  const uploaded = type({ stampUrl: '/certificate-assets/image?kind=stamp&v=8' });
  assert.equal(isDiscreteChange(draft, buildPreviewJob(state({ branding: uploaded }))), true);
  assert.equal(
    isDiscreteChange(protocol, buildPreviewJob(state({ tab: 'protocol', branding: uploaded }))),
    true,
  );
  const profile = type({
    documentProfile: { id: 'test-worker', revision: 2 },
    chairmanName: 'Другой П.',
  });
  assert.equal(isDiscreteChange(draft, buildPreviewJob(state({ branding: profile }))), true);
  // «Повторить» asks for the same job again; a wait or a message is answered without a pause.
  assert.equal(isDiscreteChange(draft, buildPreviewJob(state())), true);
  assert.equal(isDiscreteChange({ kind: 'wait' }, draft), true);
  assert.equal(isDiscreteChange({ kind: 'message', text: 'x' }, protocol), true);
  assert.equal(isDiscreteChange(draft, { kind: 'wait' }), true);
});

test('the last four PDFs are kept, the one looked at longest ago goes first', () => {
  const cache = createBytesCache();
  const pdf = (n) => new Uint8Array([n]);
  for (const n of [1, 2, 3, 4]) cache.set('k' + n, pdf(n));
  assert.deepEqual(cache.get('k1'), pdf(1), 'reading makes it the most recent');
  cache.set('k5', pdf(5));
  assert.equal(cache.get('k2'), undefined, 'the least recently used is evicted');
  for (const n of [1, 3, 4, 5]) assert.deepEqual(cache.get('k' + n), pdf(n));
  const again = pdf(9);
  cache.set('k1', again);
  assert.equal(cache.get('k1'), again, 'a key keeps one PDF');
  cache.set('k6', pdf(6));
  assert.equal(cache.get('k3'), undefined);
  assert.equal(cache.delete('k1'), true);
  assert.equal(cache.get('k1'), undefined);
  cache.clear();
  assert.equal(cache.get('k6'), undefined);
  const two = createBytesCache(2);
  for (const n of [1, 2, 3]) two.set('k' + n, pdf(n));
  assert.equal(two.get('k1'), undefined);
  assert.deepEqual(two.get('k3'), pdf(3));
});

test('a session downloads a photo once, never remembers a failure and survives a cancelled preview', async () => {
  const cache = createSessionCache(2);
  let loads = 0;
  const load = (value) => async () => {
    loads++;
    return value;
  };
  assert.equal(await cache.get('a', load('A')), 'A');
  assert.equal(await cache.get('a', load('never')), 'A');
  assert.equal(loads, 1);

  // A 403/503/429 is evicted: «Повторить» or the next preview asks again.
  let fail = true;
  const flaky = async () => {
    loads++;
    if (fail) throw new Error('CERTIFICATE_PHOTO_UNAVAILABLE');
    return 'B';
  };
  await assert.rejects(cache.get('b', flaky), /CERTIFICATE_PHOTO_UNAVAILABLE/);
  fail = false;
  assert.equal(await cache.get('b', flaky), 'B');
  assert.equal(loads, 3);
  // A loader that throws before its first await is a failure like any other.
  await assert.rejects(
    cache.get('sync', () => {
      throw new Error('SYNC');
    }),
    /SYNC/,
  );
  assert.equal(await cache.get('sync', load('S')), 'S');

  // LRU: 'a' was evicted by 'b' and 'sync'; asking again downloads again.
  const before = loads;
  await cache.get('a', load('A2'));
  assert.equal(loads, before + 1);

  // One preview is cancelled while another waits for the same photo: the download goes on.
  let release;
  let shared = 0;
  const slow = () => {
    shared++;
    return new Promise((resolve) => {
      release = () => resolve('P');
    });
  };
  const controller = new AbortController();
  const first = cache.get('p', slow, controller.signal);
  const second = cache.get('p', slow);
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  release();
  assert.equal(await second, 'P');
  assert.equal(await cache.get('p', slow), 'P');
  assert.equal(shared, 1);
  await assert.rejects(cache.get('p', slow, controller.signal), { name: 'AbortError' });

  assert.equal(cache.delete('p'), true);
  const afterDelete = cache.get('p', load('P2'));
  assert.equal(await afterDelete, 'P2');
  cache.clear();
  assert.equal(await cache.get('p', load('P3')), 'P3');
});

test('a quota answer becomes seconds to wait, and the wait can be cancelled', async () => {
  assert.equal(retryAfterSeconds('40'), 40);
  assert.equal(retryAfterSeconds(' 7 '), 7);
  assert.equal(retryAfterSeconds('0'), 1);
  assert.equal(retryAfterSeconds(null), 60);
  assert.equal(retryAfterSeconds('soon', 15), 15);
  assert.equal(retryAfterSeconds('99999'), 3600);
  const now = Date.parse('2026-09-20T10:00:00Z');
  assert.equal(retryAfterSeconds('Sun, 20 Sep 2026 10:00:30 GMT', 60, now), 30);
  assert.equal(retryAfterSeconds('Sun, 20 Sep 2026 09:00:00 GMT', 60, now), 1);

  await abortableDelay(1);
  const controller = new AbortController();
  const waiting = assert.rejects(abortableDelay(60_000, controller.signal), { name: 'AbortError' });
  controller.abort();
  await waiting;
  await assert.rejects(abortableDelay(60_000, controller.signal), { name: 'AbortError' });
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
