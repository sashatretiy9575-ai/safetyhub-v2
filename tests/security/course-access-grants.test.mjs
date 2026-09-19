import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ADMIN_COURSE_ACCESS_LIMIT } from '../../lib/constants.ts';

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
  assert.match(queue, /disabled=\{busy \|\| selection\.size === 0\}/u);
  // Several applications at once share one course picker.
  assert.match(queue, /aria-label="Курсы для выбранных заявок"/u);
  assert.match(queue, /selectedWithoutCourses\.length > 0/u);
  // The idempotency key covers the course list, so a changed list is a new operation.
  assert.match(queue, /\$\{decision\}:\$\{reason\}:\$\{courseIds\.join\(','\)\}/u);
  // WhatsApp and the profile dialog.
  // The card is brief; the application opens in a dialog with the person,
  // the ways to reach them, the course picker and the decision.
  assert.match(queue, /aria-label=\{`Открыть заявку: \$\{label\}`\}/u);
  assert.match(queue, /<CoursePicker/u);
  // WhatsApp opens with the greeting already typed.
  assert.match(
    queue,
    /whatsappChatHref\(item\.phoneE164, whatsappGreeting\(item\)\)/u,
  );
  assert.match(queue, /Вы оставляли заявку на обучение на сайте safetyhub\.kz/u);
  assert.match(queue, /target="_blank"\s+rel="noopener noreferrer"/u);
  assert.match(queue, /formatPhoneDisplay\(item\.phoneE164\)/u);
  assert.match(queue, /href=\{phoneHref\(item\.phoneE164\)\}/u);
});

test('the employee card edits the open courses through a capability-gated endpoint', async () => {
  const [panels, control, route, feature, selection] = await Promise.all([
    read('components/admin/attestations-manager-panels.tsx'),
    read('components/admin/course-access-control.tsx'),
    read('app/api/admin/users/[userId]/course-access/route.ts'),
    read('server/admin/course-access.ts'),
    read('lib/admin/course-access-selection.ts'),
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

  // One request at a time: a single PUT call site, no parallel fan-out, one
  // save loop per card, and the loop waits for each answer before it asks again.
  assert.equal(control.match(/method: 'PUT'/gu)?.length, 1);
  assert.doesNotMatch(control, /Promise\.all\(/u);
  assert.doesNotMatch(selection, /Promise\.all\(/u);
  assert.match(control, /if \(savingRef\.current\) return;\s*savingRef\.current = true;/u);
  assert.match(control, /put: \(request\) => putCourseAccess\(userId, request\)/u);
  assert.match(
    selection,
    /for \(;;\) \{\s*const \{ confirmed, pending \} = io\.read\(\);\s*const request = buildRequest\(pending, confirmed\);/u,
  );
  assert.match(selection, /const outcome = await io\.put\(request\);/u);
  // The body is the delta, never the whole ticked set.
  assert.match(control, /body: JSON\.stringify\(request\)/u);
  assert.doesNotMatch(control, /courseIds: \[/u);
  // A card opened again waits for the save its previous opening left behind.
  assert.match(
    control,
    /await inflightSaves\.get\(userId\);[\s\S]{0,120}getCourseAccess\(userId, controller\.signal\)/u,
  );
  // Search, and bulk actions that reach only what the search shows.
  assert.match(control, /type="search"/u);
  assert.match(control, /Выбрать все найденные — /u);
  assert.match(control, /Снять найденные — /u);
  assert.match(control, /bulkChange\(visible, target, /u);
  // Escape empties the search instead of closing the card's <dialog>.
  assert.match(
    control,
    /event\.key !== 'Escape' \|\| !query\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/u,
  );

  // The RPC replaces the whole set, so the route applies the change to the
  // grants it reads at that moment — unpublished courses and a second
  // administrator's ticks survive — and only then calls the RPC.
  const put = route.slice(route.indexOf('export async function PUT'));
  const readCurrent = put.indexOf('await listGrantedCourseIds(userId)');
  assert.ok(readCurrent > 0 && readCurrent < put.indexOf('.rpc('), 'grants are read before rpc(');
  assert.ok(
    put.indexOf('await consumeAdminMutationQuota') < readCurrent,
    'quota precedes the read',
  );
  assert.match(
    feature,
    /export async function listGrantedCourseIds\([\s\S]{0,200}from\('course_access_grants'\)\s*\.select\('test_id'\)\s*\.eq\('user_id', userId\)/u,
  );
  assert.match(put, /applyCourseAccessRequest\(current, change\)/u);
  assert.match(put, /p_course_ids: next \}/u);
  // A tab opened before the delta existed still sends `{ courseIds }`.
  assert.match(feature, /kind: 'replace', courseIds: legacy\.data/u);
  assert.match(put, /replaceListedCourseAccess\(/u);
  // The limit is one number for the database, the route and the card.
  assert.equal(ADMIN_COURSE_ACCESS_LIMIT, 200);
  assert.match(feature, /\.max\(ADMIN_COURSE_ACCESS_LIMIT\)/u);
  assert.match(
    put,
    /next\.length > ADMIN_COURSE_ACCESS_LIMIT\) return refuse\('COURSE_ACCESS_LIMIT'\)/u,
  );
  assert.match(selection, /openCourseTotal\(confirmed, pending\) > ADMIN_COURSE_ACCESS_LIMIT/u);
  assert.match(control, /exceedsCourseAccessLimit\(confirmedRef\.current, nextPending\)/u);
  // Refusals keep their names; the shared mapper turned the first two into
  // SERVER_ERROR 500, which the card would have taken for a lost answer.
  assert.match(put, /return courseAccessError\(error\);/u);
  for (const code of [
    'COURSE_ACCESS_COURSE_UNKNOWN',
    'ACCOUNT_UNAVAILABLE',
    'COURSE_ACCESS_LIMIT',
  ]) {
    assert.match(route, new RegExp(`'${code}'`, 'u'), code);
    assert.match(control, new RegExp(`^  ${code}: `, 'mu'), code);
  }
});

test('a locked course is refused by name on every learner surface', async () => {
  const [apiError, policyError, quiz, presentation, access, actions, learning] = await Promise.all([
    read('server/auth/api-error.ts'),
    read('server/learning/policy-error.ts'),
    read('components/quiz/quiz-client.tsx'),
    read('app/course-presentations/[slug]/[asset]/route.ts'),
    read('app/api/auth/access/route.ts'),
    read('components/topics/course-material-actions.tsx'),
    read('server/learning/course-access.ts'),
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

test('the phone is required at registration from everyone but a Chinese account', async () => {
  const [migration, schema, fields, profileRoute, onboardingRoute, profileForm, onboardingForm] =
    await Promise.all([
      read(MIGRATION),
      read('lib/validation/profile.ts'),
      read('lib/profile/fields.ts'),
      read('app/api/profile/route.ts'),
      read('app/api/profile/onboarding/route.ts'),
      read('components/profile/profile-form.tsx'),
      read('components/profile/onboarding-form.tsx'),
    ]);
  // The database still stores a missing phone as a null pair, because a
  // Chinese account may register without one.
  assert.match(migration, /\(v_phone_country_iso2 is null\) <> \(v_phone_e164 is null\)/u);
  assert.match(migration, /message = 'PROFILE_FIELDS_REQUIRED'/u);
  assert.match(schema, /nationalNumber: z\.string\(\)\.trim\(\)\.max\(64\)/u);
  assert.match(
    fields,
    /export function phoneRequiredForLocale\(locale: string\) \{\s*return locale !== 'zh';/u,
  );
  assert.match(fields, /if \(phoneRequired\) errors\.phone = \{ code: 'PHONE_INVALID' \};/u);
  for (const route of [profileRoute, onboardingRoute]) {
    assert.match(route, /!phone && phoneRequiredForLocale\(context\.profile\.preferred_locale\)/u);
    assert.match(route, /parsed\.data\.phone\.nationalNumber && !phone/u);
    assert.match(route, /p_phone_e164: phone\?\.phoneE164 \?\? null/u);
  }
  for (const form of [profileForm, onboardingForm]) {
    assert.match(form, /validateProfileSubmissionValues\(form, \{ phoneRequired \}\)/u);
    // No caption above the field: the optional mark rides in the placeholder.
    assert.match(form, /optional=\{!phoneRequired\}/u);
    assert.doesNotMatch(form, /t\('optional'\)/u);
  }
  const phoneInput = await read('components/profile/phone-input.tsx');
  assert.match(phoneInput, /t\('optional'\)/u);
  assert.match(phoneInput, /required=\{!optional\}/u);
  for (const locale of ['ru', 'kk', 'en']) {
    const messages = JSON.parse(await read(`messages/${locale}.json`));
    assert.doesNotMatch(
      messages.Profile.phoneHint,
      /Можно не указывать|Толтырмауға болады|leave this empty/u,
      locale,
    );
  }
  for (const locale of ['ru', 'kk', 'en', 'zh']) {
    const messages = JSON.parse(await read(`messages/${locale}.json`));
    assert.ok(messages.Profile.optional, locale);
  }
});
