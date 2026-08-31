import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('learner dashboard exposes one best-result model without attempt analytics', async () => {
  const [profile, loader] = await Promise.all([
    read('app/(account)/profile/page.tsx'),
    read('features/profile/server.ts'),
  ]);

  assert.match(loader, /rpc\('get_profile_dashboard'\)/);
  assert.match(profile, /identityStatus/);
  assert.match(profile, /Следующий шаг/);
  assert.match(profile, /Мои курсы/);
  assert.match(profile, /Результат/);
  assert.match(profile, /Скачать/);
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
  assert.match(client, /Лимит новых попыток исчерпан/);
  assert.match(client, /COURSE_CATALOG_MAINTENANCE/);
  assert.match(client, /Каталог курсов временно обновляется/);
  assert.match(client, /ATTEMPT_ROLLING_LIMIT/);
  assert.match(client, /payload\.error === 'ATTEMPT_NOT_FOUND'[\s\S]*clearQuizDraft/);
  assert.match(client, /errorCode === 'ATTEMPT_NOT_FOUND'[\s\S]*loadAttempt\(true\)/);
  assert.match(client, /\{attempt\.score \?\? 0\}\/\{attempt\.total\}/);
  assert.match(client, /Улучшить результат/);
  assert.doesNotMatch(client, /3 попытки|24 часа|Осталось попыток|attemptsRemaining/);
  assert.doesNotMatch(payload, /attemptsRemaining|limitWindowEndsAt/);
});

test('profile editing includes organization and preserves a single compact confirmation status', async () => {
  const [form, profile, schema, fields, route] = await Promise.all([
    read('features/auth/profile-form.tsx'),
    read('app/(account)/profile/page.tsx'),
    read('lib/validation/profile.ts'),
    read('features/profile/fields.ts'),
    read('app/api/profile/route.ts'),
  ]);

  assert.match(schema, /organization: profileField\(PROFILE_FIELD_LIMITS\.organization\)/);
  assert.match(fields, /organization: 160/);
  assert.match(form, /Данные профиля сохранены/);
  assert.match(form, /Изменить данные/);
  assert.match(profile, /Изменения на проверке/);
  assert.doesNotMatch(form, /Сейчас в действующих сертификатах/);
  assert.doesNotMatch(profile, /Данные для сертификата/);
  assert.match(form, /api\/profile\/organizations/);
  assert.match(route, /rpc\('update_profile'/);
  assert.doesNotMatch(form, /supabase\/client|\/api\/identity/);
  assert.doesNotMatch(form, /появится автоматически/);
});
