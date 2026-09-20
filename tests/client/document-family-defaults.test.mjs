import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DOCUMENT_FAMILY_DEFAULTS,
  completeDocumentProfile,
  completeParticipantFields,
  documentAudienceForPosition,
} from '../../lib/pdf/document-family-defaults.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const profile = (patch) => ({
  id: 'fixture',
  courseSlug: 'fixture',
  audience: 'all',
  label: 'Fixture',
  programName: 'Программа',
  family: 'general',
  hours: null,
  validityMonths: 0,
  protocolText: '',
  decisionText: '',
  orderNumber: '',
  orderDate: '',
  verificationKind: '',
  commission: [],
  stampAssetId: null,
  ...patch,
});

test('a blank box carries the wording of the form, and a filled one is never overwritten', () => {
  const filled = completeDocumentProfile(profile({ family: 'biot', audience: 'worker' }));
  assert.equal(filled.verificationKind, 'периодический');
  assert.equal(filled.validityMonths, 12);
  assert.match(filled.protocolText, /безопасности и охране труда/u);
  assert.match(filled.decisionText, /повторной проверке знаний/u);

  const kept = completeDocumentProfile(
    profile({ family: 'biot', verificationKind: 'внеочередной', validityMonths: 24, hours: 8 }),
  );
  assert.equal(kept.verificationKind, 'внеочередной');
  assert.equal(kept.validityMonths, 24);
  assert.equal(kept.hours, 8);

  // «Часы» left empty stays empty: the paper form of these programmes does not
  // state a volume, and a zero typed into a number input is the same as blank.
  assert.equal(completeDocumentProfile(profile({ family: 'general' })).hours, null);
  assert.equal(completeDocumentProfile(profile({ family: 'ptm', audience: 'itr' })).hours, 40);
  assert.equal(completeDocumentProfile(profile({ family: 'ptm', audience: 'worker' })).hours, 10);
  assert.equal(completeDocumentProfile(profile({ family: 'qualification' })).validityMonths, 0);
});

test('the per-listener cells are derived, and «Примечание» is always empty', () => {
  assert.equal(completeParticipantFields('ptm', 'Пожарный минимум', {}).trainingReason, 'Первичный');
  assert.equal(
    completeParticipantFields('qualification', 'Лесомонтажник', {}).qualificationDecision,
    'Лесомонтажник',
  );
  assert.equal(completeParticipantFields('biot', 'БиОТ', {}).notes, '');
  assert.equal(completeParticipantFields('biot', 'БиОТ', { notes: '  ' }).notes, '');
  assert.equal(
    completeParticipantFields('ptm', 'Пожарный минимум', { trainingReason: 'Повторный' })
      .trainingReason,
    'Повторный',
  );
});

test('the listener category follows the position the person holds', () => {
  for (const position of ['Инженер по ТБ', 'Начальник участка', 'Бригадир', 'Мастер', 'Директор'])
    assert.equal(documentAudienceForPosition(position), 'itr', position);
  for (const position of ['Стропальщик', 'Плотник', 'Сварщик', '', null])
    assert.equal(documentAudienceForPosition(position), 'worker', String(position));
});

test('the database fills the same blanks with the same words', async () => {
  const sql = await read('supabase/migrations/20260920170000_document_defaults_one_click.sql');
  for (const [family, defaults] of Object.entries(DOCUMENT_FAMILY_DEFAULTS)) {
    assert.ok(sql.includes(defaults.protocolText), `${family}: protocolText`);
    assert.ok(sql.includes(defaults.decisionText), `${family}: decisionText`);
  }
  assert.ok(sql.includes("'verificationKind','периодический'"));
  assert.ok(sql.includes("'trainingReason','Первичный'"));
  // The position rule is one regular expression in two languages; both copies
  // have to list the same words or a document changes shape on issue.
  const source = await read('lib/pdf/document-family-defaults.ts');
  const words = /\(([а-яa-z|]+)\)/iu.exec(source.split('SUPERVISORY_POSITION')[1] ?? '')?.[1];
  assert.ok(words && words.includes('руковод'));
  assert.ok(sql.includes(words));
});
