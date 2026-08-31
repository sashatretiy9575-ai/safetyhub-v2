import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function sqlFunction(source, name, schema = 'public') {
  const definition = source.match(
    new RegExp(`create(?: or replace)? function ${schema}\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  )?.[0];
  assert.ok(definition, `${schema}.${name} must exist in the migration chain`);
  return definition;
}

test('current migration chain keeps compact attempts and indexes admission by course and start time', async () => {
  const [baseline, catalogV3] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('supabase/migrations/20260825000000_course_catalog_v3.sql'),
  ]);

  assert.match(
    baseline,
    /create table public\.test_attempts \([\s\S]*revision_id uuid[\s\S]*answers smallint\[\][\s\S]*score integer/,
  );
  assert.match(
    baseline,
    /create table public\.attestations \([\s\S]*unique \(user_id, revision_id\)/,
  );
  assert.match(catalogV3, /drop index if exists public\.test_attempts_one_started_idx/);
  assert.match(catalogV3, /drop index if exists public\.test_attempts_rolling_limit_idx/);
  assert.match(
    catalogV3,
    /create unique index test_attempts_one_started_course_idx[\s\S]*user_id, test_id[\s\S]*where status = 'started'/,
  );
  assert.match(
    catalogV3,
    /create index test_attempts_calendar_limit_idx[\s\S]*user_id, test_id, started_at desc/,
  );
  assert.doesNotMatch(
    baseline,
    /create table (?:public|private)\.(?:attempt_items|attempt_answers|attempt_answer_keys|attempt_rate_limits|pending_certificate_issuances)/,
  );
  assert.doesNotMatch(baseline, /submission_hash|questions_snapshot|options_snapshot/);
});

test('attempt admission resumes first, then enforces eight starts per Asia/Oral calendar day', async () => {
  const catalogV3 = await read('supabase/migrations/20260825000000_course_catalog_v3.sql');
  const start = sqlFunction(catalogV3, 'start_test_attempt_unmetered', 'private');

  assert.match(start, /v_user_id uuid := private\.require_active_user\(\)/);
  assert.match(start, /PROFILE_ONBOARDING_REQUIRED/);
  assert.match(start, /AVATAR_REQUIRED/);
  assert.match(start, /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.match(start, /pg_advisory_xact_lock/);
  assert.match(
    start,
    /status = 'started'[\s\S]*if found then[\s\S]*return private\.attempt_payload/,
  );
  assert.match(start, /at time zone v_revision\.attempt_reset_timezone/);
  assert.match(start, /started_at >= v_day_start/);
  assert.match(start, /started_at < v_retry_at/);
  assert.match(start, /if v_count >= v_revision\.attempts_per_calendar_day then/);
  assert.match(start, /message = 'ATTEMPT_DAILY_LIMIT'/);
  assert.match(start, /detail = jsonb_build_object\('retryAt', v_retry_at\)::text/);
  assert.match(catalogV3, /add column attempts_per_calendar_day integer not null default 8/);
  assert.match(catalogV3, /add column attempt_reset_timezone text not null default 'Asia\/Oral'/);
  assert.match(catalogV3, /check \(attempt_reset_timezone = 'Asia\/Oral'\)/);
  assert.ok(
    start.indexOf("status = 'started'") <
      start.indexOf('if v_count >= v_revision.attempts_per_calendar_day'),
    'an active attempt must be returned without consuming another daily start',
  );
  assert.doesNotMatch(start, /ATTEMPT_ROLLING_LIMIT|ATTEMPT_COOLDOWN|interval '30 days'/);
});

test('completion accepts the full answer set once and atomically maintains the best result', async () => {
  const [baseline, server, client] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('features/learning/server.ts'),
    read('components/quiz/quiz-client.tsx'),
  ]);
  const complete = sqlFunction(baseline, 'complete_test_attempt');

  assert.match(complete, /where id = p_attempt_id and user_id = v_user_id[\s\S]*for update/);
  assert.match(complete, /jsonb_array_length\(p_answers\) <> v_revision\.question_count/);
  assert.match(complete, /DUPLICATE_OR_MISSING_QUESTION_ANSWER/);
  assert.match(complete, /INVALID_ATTEMPT_OPTION/);
  assert.match(complete, /set answers = v_answers/);
  assert.match(
    complete,
    /excluded\.best_score > public\.attestations\.best_score[\s\S]*excluded\.best_completed_at, excluded\.best_attempt_id[\s\S]*public\.attestations\.best_completed_at, public\.attestations\.best_attempt_id/,
  );
  assert.match(complete, /v_attempt\.score > v_active_certificate\.score/);
  assert.match(complete, /'score_improvement'/);
  assert.doesNotMatch(complete, /insert into public\.attempt_(?:items|answers)/);

  assert.match(server, /rpc\('complete_test_attempt'/);
  assert.doesNotMatch(server, /save_attempt_answer/);
  assert.doesNotMatch(client, /\/answers[`'"/]|pendingAnswersRef|saveAttemptAnswer/);
  assert.match(client, /writeQuizDraft\(/);
  assert.match(client, /JSON\.stringify\(\{ answers: submissionAnswers \}\)/);
  assert.match(client, /setInterval\(updateTimer, 1000\)/);
});

test('answer keys stay private and review is disclosed only for a passing result', async () => {
  const baseline = await read('supabase/migrations/20260813000000_safetyhub_baseline.sql');

  assert.match(baseline, /create table private\.test_revision_answer_keys/);
  assert.match(
    baseline,
    /revoke all on all tables in schema private from public, anon, authenticated, service_role/,
  );
  assert.match(baseline, /if v_attempt\.status = 'passed' then[\s\S]*'correctOptionId'/);
  assert.match(baseline, /'review', v_review/);
  assert.doesNotMatch(
    baseline,
    /grant (?:select|execute)[\s\S]{0,120}test_revision_answer_keys[\s\S]{0,80}to (?:anon|authenticated)/,
  );
});

test('attempt rate limits are actor-scoped so one corporate NAT cannot serialize a cohort', async () => {
  const [hardening, startRoute, completeRoute] = await Promise.all([
    read('supabase/migrations/20260813020000_security_hardening.sql'),
    read('app/api/attempts/route.ts'),
    read('app/api/attempts/[attemptId]/complete/route.ts'),
  ]);

  assert.match(hardening, /private\.enforce_actor_quota\('attempt\.start'\)/);
  assert.match(hardening, /private\.enforce_actor_quota\('attempt\.complete'\)/);
  assert.doesNotMatch(startRoute, /consumeBusinessQuota/);
  assert.doesNotMatch(completeRoute, /consumeBusinessQuota/);
  assert.doesNotMatch(startRoute, /consumeCoarseQuota|requestSecurityMetadata/);
  assert.doesNotMatch(completeRoute, /consumeCoarseQuota|requestSecurityMetadata/);
});
