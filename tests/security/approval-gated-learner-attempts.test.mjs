import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function sqlFunction(source, name) {
  const definition = source.match(
    new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  )?.[0];
  assert.ok(definition, `public.${name} must be defined in the approval migration`);
  return definition;
}

test('every learner attempt RPC enforces approval before its domain work', async () => {
  const migration = await read(
    'supabase/migrations/20260831111000_approved_learner_attempt_access.sql',
  );

  for (const name of [
    'start_test_attempt',
    'resume_test_attempt',
    'get_test_attempt',
    'complete_test_attempt',
  ]) {
    const definition = sqlFunction(migration, name);
    assert.match(definition, /private\.require_approved_learner\(\)/);
  }

  const start = sqlFunction(migration, 'start_test_attempt');
  const complete = sqlFunction(migration, 'complete_test_attempt');
  assert.ok(
    start.indexOf('private.require_approved_learner()') <
      start.indexOf("private.enforce_actor_quota('attempt.start')"),
    'unapproved attempts must be denied before consuming the start quota',
  );
  assert.ok(
    complete.indexOf('private.require_approved_learner()') <
      complete.indexOf("private.enforce_actor_quota('attempt.complete')"),
    'unapproved completions must be denied before consuming the completion quota',
  );
});

test('browser roles cannot bypass learner approval with direct revision reads', async () => {
  const migration = await read(
    'supabase/migrations/20260831111000_approved_learner_attempt_access.sql',
  );
  const sql = await read('supabase/tests/approval_gating.sql');

  assert.match(migration, /revoke select on public\.test_revisions from anon, authenticated/);
  assert.match(
    migration,
    /revoke select \(content, questions\) on public\.test_revisions from anon, authenticated/,
  );
  const publicProjection = migration.match(
    /grant select \([\s\S]*?\) on public\.test_revisions to anon, authenticated/,
  )?.[0];
  assert.ok(publicProjection, 'revision metadata must have an explicit browser projection');
  assert.doesNotMatch(publicProjection, /\bcontent\b/);
  assert.doesNotMatch(publicProjection, /\bquestions\b/);
  assert.match(sql, /has_table_privilege\('anon', 'public\.test_revision_variants', 'select'\)/);
  assert.match(
    sql,
    /has_column_privilege\('authenticated', 'public\.test_revision_variants', 'questions', 'select'\)/,
  );
  assert.match(sql, /has_column_privilege\('authenticated', 'public\.test_revisions', 'questions', 'select'\)/);
  assert.match(sql, /has_column_privilege\('authenticated', 'public\.test_revisions', 'content', 'select'\)/);
});

test('the quiz explains approval denial and sends the learner to their status', async () => {
  const client = await read('components/quiz/quiz-client.tsx');

  assert.match(client, /case 'ACCOUNT_APPROVAL_REQUIRED':/);
  assert.match(client, /Заявка ещё ожидает подтверждения администратора/);
  assert.match(client, /const approvalAction = errorCode === 'ACCOUNT_APPROVAL_REQUIRED';/);
  assert.match(client, /router\.push\('\/profile'\).*Открыть статус заявки/s);
});

test('SQL regression scenario distinguishes pending/rejected from approved', async () => {
  const sql = await read('supabase/tests/approval_gating.sql');

  assert.match(sql, /approval_state = 'pending'/);
  assert.match(sql, /approval_state = 'rejected'/);
  assert.match(sql, /approval_state = 'approved'/);
  assert.match(sql, /pending learner bypassed attempt approval gate/);
  assert.match(sql, /rejected learner bypassed attempt approval gate/);
  assert.match(sql, /approved learner did not pass attempt approval gate/);
  assert.match(sql, /sqlerrm = 'ACCOUNT_APPROVAL_REQUIRED'/);
  assert.match(sql, /sqlerrm = 'ATTEMPT_NOT_FOUND'/);
});

test('downstream attempt fixtures satisfy approval before testing later guards', async () => {
  const [catalog, hardening] = await Promise.all([
    read('supabase/tests/course_catalog_v3.sql'),
    read('supabase/tests/security_hardening.sql'),
  ]);

  assert.match(
    catalog,
    /update public\.account_controls[\s\S]*?approval_state = 'approved'[\s\S]*?where user_id = v_participant_b;[\s\S]*?public\.start_test_attempt\('db-v3-behavior-fixture'\)/,
  );
  assert.match(
    hardening,
    /update public\.account_controls[\s\S]*?approval_state = 'approved'[\s\S]*?where user_id = v_user_id;[\s\S]*?public\.start_test_attempt\('quota-calendar-regression'\)/,
  );
});
