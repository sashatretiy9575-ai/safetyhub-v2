import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { EDUCATION_LEVELS, educationLevel } from '../../lib/profile/education.ts';
import { PROTOCOL_MAX_PARTICIPANTS } from '../../lib/pdf/document-editor.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const MIGRATION = 'supabase/migrations/20260921100000_education_levels_and_protocol_parts.sql';

test('an older answer that names a level becomes that level, a school does not', () => {
  assert.equal(educationLevel('высшее техническое'), 'Высшее');
  assert.equal(educationLevel('  ВЫСШЕЕ '), 'Высшее');
  assert.equal(educationLevel('Неоконченное высшее'), 'Неоконченное высшее');
  assert.equal(educationLevel('незаконченное высшее'), 'Неоконченное высшее');
  assert.equal(educationLevel('Среднее профессиональное'), 'Среднее специальное');
  assert.equal(educationLevel('средне-специальное'), 'Среднее специальное');
  assert.equal(educationLevel('Колледж связи'), 'Среднее специальное');
  assert.equal(educationLevel('среднее'), 'Среднее');
  assert.equal(educationLevel('КазНУ им. Аль-Фараби'), null);
  assert.equal(educationLevel(''), null);
  assert.equal(educationLevel(null), null);
  for (const level of EDUCATION_LEVELS) assert.equal(educationLevel(level), level);
});

test('the database accepts exactly the levels the picker offers', async () => {
  const sql = await read(MIGRATION);
  const accepted = /new\.education not in \(([^)]*)\)/u.exec(sql)?.[1];
  assert.ok(accepted, 'normalize_profile_row lists the accepted levels');
  assert.deepEqual(
    [...accepted.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    [...EDUCATION_LEVELS],
  );
});

test('a protocol takes fifty people, the fifty-first opens the next part', async () => {
  assert.equal(PROTOCOL_MAX_PARTICIPANTS, 50);
  const sql = await read(MIGRATION);
  assert.match(sql, new RegExp(`c_max_participants constant integer := ${PROTOCOL_MAX_PARTICIPANTS};`, 'u'));
  assert.match(sql, /v_base\|\|'-'\|\|\(v_people\/c_max_participants\+1\)::text/u);
  // The capture that issues today keeps the same limit, a category to a protocol.
  const current = await read('supabase/migrations/20260922100000_documents_issuance_model.sql');
  assert.match(current, new RegExp(`c_max_participants constant integer := ${PROTOCOL_MAX_PARTICIPANTS};`, 'u'));
  assert.match(current, /profile_id is not distinct from p\.id and people<c_max_participants/u);
});
