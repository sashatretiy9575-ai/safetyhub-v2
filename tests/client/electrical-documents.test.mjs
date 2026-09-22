import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { courseDocumentDraft, courseDocumentPayload } from '../../lib/pdf/document-course.ts';
import { documentFamilyDefaults } from '../../lib/pdf/document-family-defaults.ts';
import {
  ELECTRICAL_GROUPS,
  ELECTRICAL_ROLES,
  ELECTRICAL_VOLTAGES,
  courseAdmission,
  electricalAdmissionText,
  electricalGroupText,
  personAdmission,
} from '../../lib/pdf/electrical.ts';
import { protocolFilename } from '../../lib/pdf/protocol-renderer.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const squeeze = (text) => text.replace(/\s+/gu, '').replace(/,(?=[)\]}])/gu, '');

const profile = (patch = {}) => ({
  id: 'elektro-all',
  courseSlug: 'elektro',
  audience: 'all',
  label: 'Электробезопасность',
  programName: 'Электробезопасность и работы на высоте',
  family: 'electrical',
  hours: null,
  validityMonths: 12,
  protocolText: '',
  decisionText: '',
  orderNumber: '',
  orderDate: '',
  verificationKind: '',
  revision: 1,
  electrical: { group: 'II', voltage: 'up-to-1000', role: 'electrotechnical' },
  ...patch,
});

test('the admission of the course is the admission of everybody it does not name', () => {
  assert.deepEqual(courseAdmission(undefined), {
    group: 'II',
    voltage: 'up-to-1000',
    role: 'electrotechnical',
  });
  assert.deepEqual(courseAdmission({ group: 'IX', voltage: 'none', role: 'nobody' }), {
    group: 'II',
    voltage: 'up-to-1000',
    role: 'electrotechnical',
  });
  const course = { group: 'III', voltage: 'up-to-1000', role: 'operational' };
  assert.deepEqual(personAdmission(course, null), course);
  assert.deepEqual(
    personAdmission(course, { electricalGroup: 'V', electricalVoltage: 'above-1000' }),
    {
      group: 'V',
      voltage: 'above-1000',
      role: 'operational',
    },
  );
  // A person is never given a group the lists do not know.
  assert.equal(personAdmission(course, { electricalGroup: 'VI' }).group, 'III');
});

test('the protocol and the booklet name the admission the way the form does', () => {
  assert.equal(
    electricalGroupText({ group: 'II', voltage: 'up-to-1000', role: 'electrotechnical' }),
    'II группа до 1000 В',
  );
  assert.equal(
    electricalGroupText({ group: 'IV', voltage: 'above-1000', role: 'electrotechnical' }),
    'IV группа до и выше 1000 В',
  );
  assert.equal(
    electricalAdmissionText({ group: 'II', voltage: 'up-to-1000', role: 'electrotechnical' }),
    'Допущен к работе в электроустановках до 1000 В, в качестве электротехнического персонала',
  );
});

test('an electrical course keeps one category, its own booklet and its admission', () => {
  const draft = courseDocumentDraft({
    courseId: '00000000-0000-4000-8000-000000000001',
    slug: 'elektro',
    title: 'Электробезопасность',
    published: true,
    profiles: [profile({ audience: 'itr' }), profile({ audience: 'worker', id: 'elektro-worker' })],
  });
  // Even stored as two categories, the form is drawn and saved as one.
  assert.equal(draft.split, false);
  const payload = courseDocumentPayload({ ...draft, split: true, booklet: null });
  assert.equal(payload.split, false);
  assert.equal(payload.booklet, null);
  assert.deepEqual(payload.electrical, {
    group: 'II',
    voltage: 'up-to-1000',
    role: 'electrotechnical',
  });
  assert.deepEqual(Object.keys(payload.categories), ['all']);
  // Another form carries no admission at all.
  assert.equal(courseDocumentPayload({ ...draft, family: 'biot' }).electrical, null);
});

test('the form of the energy rules checks a year ahead and prints no volume', () => {
  const defaults = documentFamilyDefaults('electrical');
  assert.equal(defaults.hours.all, null);
  assert.equal(defaults.validityMonths.all, 12);
  assert.equal(defaults.verificationKind, 'очередная');
});

test('a protocol of one person is filed under the person', () => {
  const item = {
    fullName: 'Орынов Руслан',
    branding: { documentProfile: { family: 'electrical', audience: 'all' } },
  };
  assert.equal(
    protocolFilename({ organization: 'ТОО «Пример»', courseTitle: 'ЭБ', items: [item] }, '128'),
    'protocols/Протокол-128-Орынов-Руслан.pdf',
  );
});

test('the database knows the same lists and the same defaults', async () => {
  const sql = await read('supabase/migrations/20260922120000_electrical_documents.sql');
  for (const group of ELECTRICAL_GROUPS) assert.ok(sql.includes(`'${group}'`), group);
  for (const voltage of ELECTRICAL_VOLTAGES) assert.ok(sql.includes(`'${voltage}'`), voltage);
  for (const role of ELECTRICAL_ROLES) assert.ok(sql.includes(`'${role}'`), role);
  assert.ok(sql.includes("'validityMonths',12,'verificationKind','очередная'"));
  // One protocol per person: the database opens a sheet of its own for each.
  assert.ok(
    sql.includes("if p->>'family' = 'electrical' and (p->>'split')::boolean then return false"),
  );
});

test('the course page asks only what the electrical form prints', async () => {
  const source = squeeze(await read('components/admin/documents/course-document-form.tsx'));
  assert.ok(source.includes("constelectrical=draft.family==='electrical'"));
  // No hours, no wording of its own, no booklet to choose: the form states them.
  assert.ok(source.includes('{electrical?null:('));
  assert.ok(source.includes('label="Группапоэлектробезопасности"'));
  assert.ok(source.includes('label="Напряжениеэлектроустановок"'));
  assert.ok(source.includes('label="Вкачестве"'));
  assert.ok(source.includes('label="Видпроверкизнаний"'));
});

test('the list of courses names the booklet of the energy rules', async () => {
  const source = squeeze(await read('app/(admin)/admin/documents/page.tsx'));
  assert.ok(source.includes("lead.family==='electrical'?'удостоверениеЭБ'"));
});

test('the person card offers the group only where the course is electrical', async () => {
  const source = squeeze(await read('components/admin/person-document-fields.tsx'));
  assert.ok(source.includes('{documents.electrical?('));
  assert.ok(source.includes("put('/api/admin/documents/electrical'"));
  // Choosing what the course states is not an override.
  assert.ok(source.includes('electrical.group===electrical.courseGroup?null:electrical.group'));
});
