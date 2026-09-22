import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  courseDocumentDraft,
  courseDocumentPayload,
  courseDocumentVersions,
  draftProfile,
  previewBranding,
} from '../../lib/pdf/document-course.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const LIST = 'app/(admin)/admin/documents/page.tsx';
const COMMON_PAGE = 'app/(admin)/admin/documents/common/page.tsx';
const COURSE_PAGE = 'app/(admin)/admin/documents/[course]/page.tsx';
const LEGACY_PAGE = 'app/(admin)/admin/settings/certificate/page.tsx';
const COMMON = 'components/admin/documents/common-document-form.tsx';
const COURSE = 'components/admin/documents/course-document-form.tsx';
const TILE = 'components/admin/documents/facsimile-upload-tile.tsx';
const PERSON = 'components/admin/person-document-fields.tsx';

/** Line breaks and the trailing commas a formatter adds with them say nothing about the code. */
const squeeze = (text) => text.replace(/\s+/gu, '').replace(/,(?=[)\]}])/gu, '');

const setupOf = (profiles) => ({
  courseId: '00000000-0000-4000-8000-000000000001',
  slug: 'biot',
  title: 'БиОТ',
  published: true,
  profiles,
});
const body = (audience, patch = {}) => ({
  id: `biot-${audience}`,
  courseSlug: 'biot',
  audience,
  label: 'БиОТ',
  programName: 'Безопасность и охрана труда',
  family: 'biot',
  hours: null,
  validityMonths: 0,
  protocolText: '',
  decisionText: '',
  orderNumber: '',
  orderDate: '',
  verificationKind: '',
  revision: 3,
  ...patch,
});
const common = {
  organizationName: 'ТОО «Пример»',
  bin: '000000000000',
  validityMonths: 12,
  examTextKk: 'Жалпы',
  examTextRu: 'Общая корочка',
  knowledgeTextKk: 'Жалпы',
  knowledgeTextRu: 'Общая',
  documentDefaults: {
    reviewerName: 'Проверяющий П.П.',
    commission: [],
    companyName: '',
    programName: '',
    protocolText: '',
    insertWidthCm: 32,
    insertHeightCm: 10,
  },
  documentCommission: {
    signers: [
      { signerId: 'chairman', name: 'Председатель П.П.', position: 'Директор', assetId: null },
      { signerId: 'member-1', name: 'Член К.К.', position: 'Преподаватель', assetId: null },
    ],
    stampAssetId: '00000000-0000-4000-8000-0000000000aa',
  },
};
const OWN_BOOKLET = {
  examTextKk: 'Өз',
  examTextRu: 'Своя корочка',
  knowledgeTextKk: 'Өз',
  knowledgeTextRu: 'Своя',
};

test('a course is set up once: one wording, «ИТР» and «рабочие» with hours and terms of their own', () => {
  const split = setupOf([
    body('itr', { hours: 40 }),
    body('worker', { validityMonths: 0, noExpiry: true }),
  ]);
  const draft = courseDocumentDraft(split);
  assert.equal(draft.split, true);
  assert.deepEqual(draft.categories, {
    itr: { hours: 40, validityMonths: null },
    worker: { hours: null, validityMonths: 0 },
  });
  assert.deepEqual(courseDocumentVersions(split), { 'biot-itr': 3, 'biot-worker': 3 });
  // Only the categories the course keeps are sent, and the order only on the БиОТ form.
  const one = courseDocumentPayload({ ...draft, split: false, family: 'general', orderNumber: '№ 1' });
  assert.deepEqual(Object.keys(one.categories), ['all']);
  assert.equal(one.orderNumber, '');
  assert.equal(courseDocumentPayload({ ...draft, orderNumber: ' № 7 ' }).orderNumber, '№ 7');
  // «Своя корочка» is the course's own four texts on the standard layout.
  assert.deepEqual(courseDocumentPayload({ ...draft, booklet: OWN_BOOKLET }).booklet, {
    layout: 'standard',
    texts: OWN_BOOKLET,
  });
  assert.equal(courseDocumentPayload(draft).booklet, null);
});

test('the preview is assembled the way issuance assembles the document', () => {
  const split = setupOf([body('itr', { hours: 40 }), body('worker')]);
  const draft = { ...courseDocumentDraft(split), booklet: OWN_BOOKLET };
  const worker = draftProfile(split, draft, 'worker');
  const branding = previewBranding(common, worker, { date: '2026-09-22', number: '22.09' });
  // The commission and the stamp of «Общее», the category's own profile.
  assert.equal(branding.chairmanName, 'Председатель П.П.');
  assert.equal(branding.documentDefaults.commission[0].name, 'Член К.К.');
  assert.equal(
    branding.stampUrl,
    '/certificate-assets/registered?id=00000000-0000-4000-8000-0000000000aa',
  );
  assert.equal(branding.documentProfile.audience, 'worker');
  assert.equal(branding.documentProfile.hours, 10);
  assert.equal(branding.validityMonths, 12);
  assert.equal(branding.protocolNumber, '22.09');
  assert.equal(branding.examTextRu, 'Своя корочка');
  const plain = previewBranding(common, draftProfile(split, { ...draft, booklet: null }, 'itr'), {
    date: '2026-09-22',
    number: '22.09',
  });
  assert.equal(plain.examTextRu, 'Общая корочка');
  assert.equal(plain.documentProfile.hours, 40);
});

test('the pages are the section «Документы», each behind its own capability check', async () => {
  const [list, commonPage, coursePage, legacy, layout, hub] = await Promise.all([
    read(LIST),
    read(COMMON_PAGE),
    read(COURSE_PAGE),
    read(LEGACY_PAGE),
    read('app/(admin)/admin/layout.tsx'),
    read('app/(admin)/admin/settings/page.tsx'),
  ]);
  for (const page of [list, commonPage, coursePage]) {
    assert.match(page, /export const dynamic = 'force-dynamic';/u);
    assert.match(page, /await requireCapability\('site\.settings\.manage'\);/u);
  }
  assert.match(list, /href="\/admin\/documents\/common"/u);
  assert.match(list, /href=\{`\/admin\/documents\/\$\{encodeURIComponent\(course\.slug\)\}`\}/u);
  // A course named by the id older links carry is shown under its slug.
  assert.match(coursePage, /params: Promise<\{ course: string \}>/u);
  assert.match(coursePage, /if \(!setup\) notFound\(\);/u);
  assert.match(coursePage, /redirect\(/u);
  // The old editor's address lands on the new pages.
  assert.match(legacy, /redirect\('\/admin\/documents'\)/u);
  assert.match(legacy, /`\/admin\/documents\/\$\{encodeURIComponent\(course\)\}/u);
  assert.doesNotMatch(legacy, /CertificateSettingsForm|readDocumentEditor/u);
  // One place in the menu, and only for those who can use it.
  assert.match(
    layout,
    /actor\.capabilities\.includes\('site\.settings\.manage'\)\s*\?\s*\[\{ href: '\/admin\/documents', icon: Certificate, label: 'Документы' \}\]/u,
  );
  assert.doesNotMatch(hub, /\/admin\/settings\/certificate/u);
});

test('the owner’s rules: names inside the fields, no sentences, one save, no leaving without it', async () => {
  const [commonForm, courseForm, tile, person] = await Promise.all([
    read(COMMON),
    read(COURSE),
    read(TILE),
    read(PERSON),
  ]);
  for (const source of [commonForm, courseForm, tile, person]) {
    // No caption above a field: its name is its placeholder or lives in the frame.
    assert.doesNotMatch(source, /<Label\b|<label\b[^>]*>\s*<span/u);
  }
  for (const source of [commonForm, courseForm]) {
    assert.equal(source.match(/onClick=\{\(\) => void save\(\)\}/gu)?.length, 1);
    assert.match(source, /useUnsavedChangesGuard\(dirty, \{ title: 'Уйти без сохранения\?' \}\)/u);
    assert.match(source, /data-hydrated=\{hydrated \? '' : undefined\}/u);
    assert.match(source, /aria-label="Сохранить"/u);
    assert.match(source, /'Сохранено в другом окне — обновите страницу'/u);
  }
  // The course page: the form, one or two categories, the booklet, the preview.
  for (const text of ['Форма протокола', 'Одна', 'ИТР и рабочие', 'Общая корочка', 'Своя корочка']) {
    assert.ok(courseForm.includes(`'${text}'`) || courseForm.includes(`"${text}"`), text);
  }
  assert.match(courseForm, /<DocumentPreviewPane/u);
  assert.match(
    courseForm,
    /\/api\/admin\/documents\/courses\/\$\{encodeURIComponent\(setup\.courseId\)\}/u,
  );
  // «Общее»: the commission with a signature each, the seal, the booklet.
  assert.match(commonForm, /ownerId=\{DOCUMENT_STAMP_OWNER\}\s+kind="stamp"/u);
  assert.match(commonForm, /ownerId=\{signer\.signerId\}\s+kind="signature"/u);
  assert.match(commonForm, /disabled=\{signers\.length <= 1\}/u);
  assert.match(commonForm, /disabled=\{signers\.length >= MAX_SIGNERS\}/u);
  assert.match(
    commonForm,
    /clientFetch\('\/api\/admin\/settings\/certificate', \{\s*method: 'PATCH',/u,
  );
  // An upload is one PUT of a prepared PNG; it is drawn once «Общее» is saved.
  assert.ok(
    squeeze(tile).includes(
      squeeze(`clientFetch(
    '/api/admin/documents/assets?' + new URLSearchParams({ owner: ownerId, kind }),
    { method: 'PUT', headers: { 'content-type': 'image/png' }, body },
    { timeoutMs: UPLOAD_TIMEOUT_MS },
  )`),
    ),
  );
  assert.match(tile, /uploadFacsimile\(ownerId, kind, await prepareFacsimilePng\(file\)\)/u);
  assert.doesNotMatch(tile, /DELETE|Удалить|<img\b/u);
  // The card: the category where the course splits, and the note.
  assert.match(person, /\{documents\.split \? \(/u);
  assert.match(person, /audience === documents\.positionAudience \? null : audience/u);
  assert.match(person, /'\/api\/admin\/documents\/notes'/u);
});
