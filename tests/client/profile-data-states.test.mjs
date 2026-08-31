import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverSource = await readFile('features/profile/server.ts', 'utf8');
const pageSource = await readFile('app/(account)/profile/page.tsx', 'utf8');
const failureSource = await readFile('components/shared/data-load-failure.tsx', 'utf8');

test('profile data failures carry a server correlation id instead of becoming empty data', () => {
  assert.match(serverSource, /randomUUID\(\)/);
  assert.match(serverSource, /state: 'failed'; correlationId: string/);
  assert.doesNotMatch(serverSource, /state: 'unavailable'/);
  assert.match(serverSource, /PROFILE_SECTION_LOAD_FAILED/);
});

test('profile distinguishes read failures from honest empty states and offers retry', () => {
  assert.match(pageSource, /dashboardResult\.state === 'ready'/);
  assert.match(pageSource, /dashboardResult\.state === 'failed'/);
  assert.match(pageSource, /DataLoadFailure/);
  assert.match(pageSource, /Результаты обучения временно не загрузились/);
  assert.match(failureSource, /Код обращения:/);
  assert.match(failureSource, /router\.refresh\(\)/);
  assert.match(failureSource, /Повторить загрузку/);
});

test('profile keeps approved identity in the server model without duplicating it in the editor', async () => {
  const formSource = await readFile('features/auth/profile-form.tsx', 'utf8');
  assert.match(serverSource, /rpc\('get_profile_dashboard'\)/);
  assert.match(serverSource, /approvedIdentity/);
  assert.match(formSource, /Изменить данные/);
  assert.doesNotMatch(formSource, /CurrentProfile|IdentityPanel/);
  assert.doesNotMatch(formSource, /Сейчас в действующих сертификатах/);
  assert.doesNotMatch(pageSource, /Данные для сертификата/);
  assert.doesNotMatch(formSource, /\/api\/identity/);
  assert.doesNotMatch(formSource, /supabase\/client/);
});
