import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('avatar is square, privately staged, and published only through its manifest', async () => {
  const [compressor, uploader, route, profileServer, layout] = await Promise.all([
    read('lib/avatar-image.ts'),
    read('features/profile/avatar-uploader.tsx'),
    read('app/api/profile/avatar/route.ts'),
    read('features/profile/server.ts'),
    read('app/(account)/layout.tsx'),
  ]);

  assert.match(compressor, /AVATAR_MAX_BYTES = 100 \* 1024/);
  assert.match(compressor, /AVATAR_TARGET_BYTES = 50 \* 1024/);
  assert.match(compressor, /AVATAR_WIDTH = 360/);
  assert.match(compressor, /AVATAR_HEIGHT = 360/);
  assert.match(compressor, /'image\/jpeg', 'image\/png', 'image\/webp'/);
  assert.match(compressor, /AVATAR_OUTPUT_TYPES = \['image\/webp', 'image\/jpeg'\]/);
  assert.match(uploader, /\/api\/profile\/avatar/);
  assert.match(uploader, /avatar\.type === 'image\/jpeg'/);
  assert.match(uploader, /scrollIntoView/);
  assert.match(uploader, /feedback\.kind === 'error' \? 'alert' : 'status'/);
  assert.doesNotMatch(uploader, /createClient|storage\.from|router\.refresh/);
  assert.match(route, /createAdminClient/);
  assert.match(route, /avatar\.type !== 'image\/webp' && avatar\.type !== 'image\/jpeg'/);
  assert.match(route, /avatar\.size <= 0 \|\| avatar\.size > AVATAR_MAX_BYTES/);
  assert.match(route, /normalizeAvatarImage\(receivedBytes, avatar\.type\)/);
  assert.match(route, /begin_profile_avatar_upload/);
  assert.match(route, /mark_profile_avatar_staged/);
  assert.match(route, /finalize_profile_avatar_upload/);
  assert.match(route, /\.upload\(begin\.objectKey, bytes, \{/);
  assert.match(route, /upsert: false/);
  assert.doesNotMatch(route, /mark_profile_avatar_uploaded|avatar\.webp|upsert: true/);
  assert.match(profileServer, /rpc\('get_my_profile_avatar_manifest'\)/);
  assert.match(profileServer, /createSignedUrl\(manifest\.data\.objectKey, 10 \* 60\)/);
  assert.match(layout, /auth\?\.profile\.avatar_updated_at/);
});

test('profile uses one dashboard contract and keeps attempt analytics hidden', async () => {
  const [profile, server, form] = await Promise.all([
    read('app/(account)/profile/page.tsx'),
    read('features/profile/server.ts'),
    read('features/auth/profile-form.tsx'),
  ]);
  assert.match(profile, /Личный кабинет/);
  assert.match(profile, /Следующий шаг/);
  assert.match(profile, /Мои курсы/);
  assert.match(profile, /Сдано \{passed\} из \{current\.length\} · Сертификатов \{issued\}/);
  assert.match(profile, /Скачать/);
  assert.match(profile, /compact/);
  assert.match(profile, /Мои данные/);
  assert.match(profile, /data-learning-dashboard data-state="ready"/);
  assert.match(profile, /data-learning-dashboard data-state="failed"/);
  assert.doesNotMatch(profile, /Лучшие результаты|Ваше обучение|Данные для сертификата/);
  assert.match(server, /getProfileDashboard/);
  assert.match(server, /rpc\('get_profile_dashboard'\)/);
  assert.doesNotMatch(profile, /PassRateChart|ActivityChart|ResultDistribution|RecentAttempts/);
  assert.doesNotMatch(profile, /количество попыток|Осталось попыток|Последние попытки/i);
  assert.doesNotMatch(form, /\/api\/identity|supabase\/client/);
});

test('account deletion is explicit, irreversible, and hands off to durable cleanup', async () => {
  const [control, route, auth] = await Promise.all([
    read('features/profile/account-deletion.tsx'),
    read('app/api/profile/account/route.ts'),
    read('features/auth/server.ts'),
  ]);
  assert.match(control, /confirmation !== CONFIRMATION/);
  assert.match(control, /PDF\s+физически удалить невозможно/);
  assert.match(route, /rpc\('begin_user_account_purge'/);
  assert.match(route, /requireAccountDeletionUser\(\)/);
  assert.doesNotMatch(route, /p_target_id:\s*(?:body|request|params|searchParams)/);
  assert.doesNotMatch(route, /storage\.from|\.remove\(|rpc\('purge_user_account'/);

  // Normal application authorization remains fail-closed after phase one.
  assert.match(
    auth,
    /export async function requireUser[\s\S]*?if \(context\.deletionPending\)[\s\S]*?'DELETION_PENDING'/,
  );
  // The deletion-only guard authenticates the owner and checks suspension, but
  // deliberately does not reject deletion_pending so a failed purge can resume.
  const deletionGuard = auth.match(
    /export async function requireAccountDeletionUser\(\) \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(deletionGuard);
  assert.match(deletionGuard, /await getAuthContext\(\)/);
  assert.match(deletionGuard, /context\.status !== 'active'/);
  assert.doesNotMatch(deletionGuard, /deletionPending|DELETION_PENDING/);
  assert.equal(route.match(/p_target_id: context\.user\.id/g)?.length, 1);

  assert.match(route, /pendingPurge\(data, context\.user\.id\)/);
  assert.match(route, /NextResponse\.json\(pending, \{ status: 202 \}\)/);
  assert.match(route, /tombstoneId/);
  assert.match(route, /cleanupNotBefore/);
  assert.match(route, /Clear-Site-Data/);
});
