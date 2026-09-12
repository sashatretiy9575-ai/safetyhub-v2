import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const MIGRATION = 'supabase/migrations/20260912130000_course_access_grants.sql';

test('course access is a table the browser never touches, gated inside the learner RPCs', async () => {
  const migration = await read(MIGRATION);
  assert.match(migration, /create table public\.course_access_grants/u);
  assert.match(migration, /primary key \(user_id, test_id\)/u);
  assert.match(migration, /alter table public\.course_access_grants enable row level security/u);
  assert.match(
    migration,
    /revoke all on public\.course_access_grants from public, anon, authenticated/u,
  );
  // Both learner entry points ask after the account gate and before quotas.
  for (const fn of ['start_test_attempt_locale', 'get_approved_course_presentation_locale']) {
    const body = migration.slice(migration.indexOf(`function public.${fn}(`));
    const gate = body.indexOf('private.require_course_access_by_slug(');
    const approval = body.indexOf('private.require_approved_learner()');
    assert.ok(approval >= 0 && gate > approval, `${fn}: course gate follows the approval gate`);
  }
  assert.match(migration, /message = 'COURSE_ACCESS_REQUIRED'/u);
  // Administrators check courses themselves and are never locked out.
  assert.match(migration, /user_role\.product_role = 'admin'/u);
  // The audit whitelist gains the access change and keeps every earlier event.
  for (const action of [
    'account.approval.approved',
    'course.access.changed',
    'test.passed',
    'certificate.issued',
    'user.self_delete_requested',
    'user.purged',
    'user.self_purged',
    'role.changed',
  ]) {
    assert.match(migration, new RegExp(`'${action.replaceAll('.', '\\.')}'`, 'u'), action);
  }
  // Learners approved under the old rule keep the courses they already had.
  assert.match(
    migration,
    /where control\.approval_state = 'approved'\s+and test\.status = 'published'/u,
  );
});

test('the approval decision names the courses it opens and stays idempotent per course list', async () => {
  const migration = await read(MIGRATION);
  const route = await read('app/api/admin/account-approvals/[userId]/route.ts');
  assert.match(migration, /p_course_ids uuid\[\]\s*\)/u);
  assert.match(migration, /'courseIds', case when cardinality\(v_course_ids\) > 0/u);
  assert.match(
    migration,
    /insert into public\.course_access_grants \(user_id, test_id, granted_by\)/u,
  );
  assert.match(migration, /message = 'COURSE_ACCESS_COURSE_UNKNOWN'/u);
  // The legacy four-argument form survives as a wrapper for older callers.
  assert.match(
    migration,
    /create or replace function public\.decide_account_approval\(\s*p_idempotency_key uuid,\s*p_target_user_id uuid,\s*p_decision text,\s*p_reason text default null\s*\)/u,
  );
  // The route always sends the fifth argument and refuses an approval that
  // opens nothing.
  assert.match(route, /courseIds: z\.array\(z\.string\(\)\.uuid\(\)\)\.min\(1\)\.max\(200\)/u);
  assert.match(route, /p_course_ids: data\.decision === 'approved' \? data\.courseIds : null/u);
  assert.match(route, /p_course_ids: string\[\] \| null/u);
});

test('the queue ticks courses per application and reaches the applicant on WhatsApp', async () => {
  const [queue, page] = await Promise.all([
    read('components/admin/account-approval-queue.tsx'),
    read('app/(admin)/admin/approvals/page.tsx'),
  ]);
  assert.match(page, /listAdminCourseOptions\(\)/u);
  assert.match(
    page,
    /<AccountApprovalQueue items=\{result\.data\.items\} courses=\{courses\} \/>/u,
  );
  // Nothing is pre-ticked: access is granted by hand, course by course.
  assert.match(queue, /useState<Record<string, ReadonlySet<string>>>\(\s*\{\},?\s*\)/u);
  assert.match(queue, /decision === 'approved' && courseIds\.length === 0/u);
  assert.match(queue, /\.\.\.\(decision === 'rejected' \? \{ reason \} : \{ courseIds \}\)/u);
  assert.match(queue, /disabled=\{actionDisabled \|\| selection\.size === 0\}/u);
  // Several applications at once share one course picker.
  assert.match(queue, /aria-label="Курсы для выбранных заявок"/u);
  assert.match(queue, /selectedWithoutCourses\.length > 0/u);
  // The idempotency key covers the course list, so a changed list is a new operation.
  assert.match(queue, /\$\{decision\}:\$\{reason\}:\$\{courseIds\.join\(','\)\}/u);
  // WhatsApp and the profile dialog.
  assert.match(queue, /https:\/\/wa\.me\/\$\{phoneE164\.replace\(\/\\D\/g, ''\)\}/u);
  assert.match(queue, /target="_blank"\s+rel="noopener noreferrer"/u);
  assert.match(queue, /function ApplicantProfileDialog/u);
  assert.match(queue, /formatPhoneDisplay\(item\.phoneE164\)/u);
  assert.match(queue, /href=\{`tel:\$\{item\.phoneE164\}`\}/u);
});

test('the employee card edits the open courses through a capability-gated endpoint', async () => {
  const [panels, control, route, feature] = await Promise.all([
    read('components/admin/attestations-manager-panels.tsx'),
    read('components/admin/course-access-control.tsx'),
    read('app/api/admin/users/[userId]/course-access/route.ts'),
    read('features/admin/course-access.ts'),
  ]);
  assert.match(panels, /<CourseAccessControl/u);
  assert.match(panels, /canManage=\{permissions\.canManageIdentity\}/u);
  assert.match(control, /\/api\/admin\/users\/\$\{userId\}\/course-access/u);
  assert.match(control, /method: 'PUT'/u);
  assert.match(route, /requireAnyCapability\(\['identity\.read', 'identity\.manage'\]\)/u);
  assert.match(route, /requireCapability\('identity\.manage'\)/u);
  assert.match(route, /invalidOriginResponse\(request\)/u);
  assert.match(route, /consumeAdminMutationQuota\(\s*'admin\.identity\.mutate'/u);
  assert.match(route, /rpc\(\s*'set_course_access'/u);
  assert.match(feature, /\.eq\('status', 'published'\)/u);
  assert.match(feature, /from\('course_access_grants'\)/u);
});

test('a locked course is refused by name on every learner surface', async () => {
  const [apiError, policyError, quiz, presentation, access, actions, learning] = await Promise.all([
    read('features/auth/api-error.ts'),
    read('features/learning/policy-error.ts'),
    read('components/quiz/quiz-client.tsx'),
    read('app/course-presentations/[slug]/[asset]/route.ts'),
    read('app/api/auth/access/route.ts'),
    read('components/topics/course-material-actions.tsx'),
    read('features/learning/course-access.ts'),
  ]);
  assert.match(apiError, /COURSE_ACCESS_REQUIRED.*status: 403/su);
  assert.match(policyError, /\| 'COURSE_ACCESS_REQUIRED'/u);
  assert.match(policyError, /code === 'COURSE_ACCESS_REQUIRED'\s*\?\s*403/u);
  assert.match(quiz, /case 'COURSE_ACCESS_REQUIRED':/u);
  assert.match(quiz, /t\('errors\.courseAccessRequired'\)/u);
  assert.match(presentation, /'COURSE_ACCESS_REQUIRED',/u);
  // The course page asks about its own course; answers are cached per course.
  assert.match(access, /hasCourseAccess\(context\.user\.id, slug\)/u);
  assert.match(access, /access: 'course_locked'/u);
  assert.match(actions, /\/api\/auth\/access\?course=\$\{encodeURIComponent\(course\.slug\)\}/u);
  assert.match(actions, /new Map<string, CourseMaterialAccess>\(\)/u);
  assert.match(actions, /course_locked: \{ title: t\('access\.lockedTitle'\)/u);
  assert.match(learning, /from\('course_access_grants'\)/u);
  const messages = JSON.parse(await read('messages/ru.json'));
  assert.ok(messages.Quiz.errors.courseAccessRequired);
  assert.ok(messages.Course.access.lockedTitle);
});

test('the phone is optional at registration; name, job and company stay required', async () => {
  const [migration, schema, fields, profileRoute, onboardingRoute, profileForm, onboardingForm] =
    await Promise.all([
      read(MIGRATION),
      read('lib/validation/profile.ts'),
      read('features/profile/fields.ts'),
      read('app/api/profile/route.ts'),
      read('app/api/profile/onboarding/route.ts'),
      read('features/auth/profile-form.tsx'),
      read('features/profile/onboarding-form.tsx'),
    ]);
  assert.match(migration, /\(v_phone_country_iso2 is null\) <> \(v_phone_e164 is null\)/u);
  assert.match(migration, /message = 'PROFILE_FIELDS_REQUIRED'/u);
  assert.match(schema, /nationalNumber: z\.string\(\)\.trim\(\)\.max\(64\)/u);
  assert.doesNotMatch(schema, /nationalNumber: z\.string\(\)\.trim\(\)\.min\(1\)/u);
  assert.match(fields, /if \(!nationalNumber\) return errors;/u);
  for (const route of [profileRoute, onboardingRoute]) {
    assert.match(route, /parsed\.data\.phone\.nationalNumber && !phone/u);
    assert.match(route, /p_phone_e164: phone\?\.phoneE164 \?\? null/u);
  }
  for (const form of [profileForm, onboardingForm]) {
    assert.match(form, /t\('optional'\)/u);
  }
  for (const locale of ['ru', 'kk', 'en', 'zh']) {
    const messages = JSON.parse(await read(`messages/${locale}.json`));
    assert.ok(messages.Profile.optional, locale);
  }
});
