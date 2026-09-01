import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('learner dashboard exposes one best-result model without attempt analytics', async () => {
  const [profile, loader] = await Promise.all([
    read('app/(account)/profile/page.tsx'),
    read('features/profile/server.ts'),
  ]);

  assert.match(loader, /rpc\('get_profile_dashboard_locale', \{/);
  assert.match(loader, /p_locale: locale/);
  assert.match(profile, /const canAccessLearning = context\.approval\.state === 'approved'/);
  assert.match(profile, /\{canAccessLearning \? \(/);
  assert.match(profile, /t\('nextStep'\)/);
  assert.match(profile, /t\('coursesTitle'\)/);
  assert.match(profile, /t\('result'\)/);
  assert.match(profile, /t\('download'\)/);
  assert.doesNotMatch(profile, /Доступные курсы|Лучший результат/);
  assert.doesNotMatch(profile, /RecentAttempts|ActivityChart|ResultDistribution|PassRateChart/);
  assert.doesNotMatch(profile, /количество попыток|Осталось попыток|Последние попытки/i);
});

test('quiz reveals a failed score and explains the calendar-day limit without usage analytics', async () => {
  const [client, payload] = await Promise.all([
    read('components/quiz/quiz-client.tsx'),
    read('features/learning/types.ts'),
  ]);

  assert.match(client, /ATTEMPT_DAILY_LIMIT/);
  assert.match(client, /t\('errors\.dailyLimitAt', \{ availableAt \}\)/);
  assert.match(client, /t\('errors\.dailyLimitUnknown', \{ count: 8 \}\)/);
  assert.match(client, /COURSE_CATALOG_MAINTENANCE/);
  assert.match(client, /t\('errors\.catalogMaintenance'\)/);
  assert.match(client, /ATTEMPT_ROLLING_LIMIT/);
  assert.match(client, /payload\.error === 'ATTEMPT_NOT_FOUND'[\s\S]*clearQuizDraft/);
  assert.match(client, /errorCode === 'ATTEMPT_NOT_FOUND'[\s\S]*loadAttempt\(true\)/);
  assert.match(client, /\{attempt\.score \?\? 0\}\/\{attempt\.total\}/);
  assert.match(client, /t\('improveResult'\)/);
  assert.doesNotMatch(client, /3 попытки|24 часа|Осталось попыток|attemptsRemaining/);
  assert.doesNotMatch(payload, /attemptsRemaining|limitWindowEndsAt/);
});

test('profile editing includes organization and renders the account-approval status', async () => {
  const [form, profile, approvalStatus, schema, fields, route] = await Promise.all([
    read('features/auth/profile-form.tsx'),
    read('app/(account)/profile/page.tsx'),
    read('features/profile/account-approval-status.tsx'),
    read('lib/validation/profile.ts'),
    read('features/profile/fields.ts'),
    read('app/api/profile/route.ts'),
  ]);

  assert.match(schema, /organization: profileField\(PROFILE_FIELD_LIMITS\.organization\)/);
  assert.match(fields, /organization: 160/);
  assert.match(form, /useTranslations\('Profile'\)/);
  assert.match(form, /t\('saved'\)/);
  assert.match(form, /t\('edit'\)/);
  assert.match(profile, /AccountApprovalStatus/);
  assert.match(approvalStatus, /useTranslations\('Approval'\)/);
  assert.match(approvalStatus, /t\('pendingTitle'\)/);
  assert.match(approvalStatus, /t\('remaining'\)/);
  assert.doesNotMatch(form, /Сейчас в действующих сертификатах/);
  assert.doesNotMatch(profile, /Данные для сертификата/);
  assert.match(form, /api\/profile\/organizations/);
  assert.match(route, /rpc\(\s*'submit_profile_for_approval_from_trusted_server'/);
  assert.doesNotMatch(form, /supabase\/client|\/api\/identity/);
  assert.doesNotMatch(form, /появится автоматически/);
});
