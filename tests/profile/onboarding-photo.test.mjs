import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('new registrations continue to use email auth and enter required onboarding', async () => {
  const [register, registerRoute, callback, constants, page, form, route] = await Promise.all([
    read('app/(account)/auth/register/page.tsx'),
    read('app/api/auth/register/route.ts'),
    read('app/(account)/callback/route.ts'),
    read('lib/constants.ts'),
    read('app/(account)/onboarding/page.tsx'),
    read('features/profile/onboarding-form.tsx'),
    read('app/api/profile/onboarding/route.ts'),
  ]);

  assert.match(register, /clientRequest\('\/api\/auth\/register'/);
  assert.match(registerRoute, /auth\.signUp/);
  assert.match(registerRoute, /auth\/callback\?next=\/onboarding/);
  assert.match(callback, /safeRedirectPath/);
  assert.match(constants, /onboarding: '\/onboarding'/);
  assert.match(constants, /\^\\\/onboarding/);
  assert.match(page, /onboarding_completed_at/);
  assert.match(page, /redirect\('\/topics'\)/);
  assert.match(form, /name/);
  assert.match(form, /surname/);
  assert.match(form, /job/);
  assert.match(form, /organization/);
  assert.match(form, /<AvatarUploader/);
  assert.match(route, /requireUser\(\)/);
  assert.match(route, /complete_profile_onboarding/);
  assert.match(route, /context\.profile\.avatar_updated_at/);
  assert.doesNotMatch(route, /storage\.from|\.list\(/);
  assert.match(route, /AVATAR_REQUIRED/);
});

test('avatar flow supports camera, system fallback, crop controls, and mandatory cleanup', async () => {
  const [uploader, image, uploadRoute, config] = await Promise.all([
    read('features/profile/avatar-uploader.tsx'),
    read('lib/avatar-image.ts'),
    read('app/api/profile/avatar/route.ts'),
    read('next.config.ts'),
  ]);

  assert.match(uploader, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(uploader, /facingMode: \{ ideal: 'user' \}/);
  assert.match(uploader, /capture="user"/);
  assert.match(uploader, /Сделать фото/);
  assert.match(uploader, /Выбрать из устройства/);
  assert.match(uploader, /Сфотографировать/);
  assert.match(uploader, /Переснять/);
  assert.match(uploader, /Использовать фото/);
  assert.match(uploader, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(uploader, /pagehide/);
  assert.match(uploader, /visibilitychange/);
  assert.match(uploader, /onPointerMove/);
  assert.match(uploader, /\/api\/profile\/avatar/);
  assert.doesNotMatch(uploader, /supabase\/client|storage\.from/);
  assert.doesNotMatch(uploader, /storage\.from\(AVATAR_BUCKET\)\.remove/);
  assert.doesNotMatch(uploader, /<Trash/);
  assert.match(image, /AVATAR_SOURCE_MAX_BYTES = 8 \* 1024 \* 1024/);
  assert.match(image, /AVATAR_SOURCE_MAX_PIXELS = 24_000_000/);
  assert.match(image, /AVATAR_WIDTH = 360/);
  assert.match(image, /AVATAR_HEIGHT = 360/);
  assert.match(image, /AVATAR_TARGET_BYTES = 50 \* 1024/);
  assert.doesNotMatch(image, /OUTPUT_SCALES/);
  assert.match(image, /AVATAR_MAX_BYTES/);
  assert.match(uploadRoute, /avatar\.type !== 'image\/webp'/);
  assert.match(uploadRoute, /dimensions\?\.width !== AVATAR_WIDTH/);
  assert.match(uploadRoute, /begin_profile_avatar_upload/);
  assert.match(uploadRoute, /mark_profile_avatar_staged/);
  assert.match(uploadRoute, /finalize_profile_avatar_upload/);
  assert.match(uploadRoute, /\.upload\(begin\.objectKey, bytes, \{/);
  assert.match(uploadRoute, /upsert: false/);
  assert.doesNotMatch(
    uploadRoute,
    /mark_profile_avatar_uploaded|\$\{context\.user\.id\}\/avatar\.webp|upsert: true/,
  );
  assert.match(config, /camera=\(self\)/);
  assert.match(config, /camera=\(\)/);
});

test('a missing committed avatar sends an already-onboarded learner back to photo setup', async () => {
  const [page, profileServer, migration, policy, quiz] = await Promise.all([
    read('app/(account)/onboarding/page.tsx'),
    read('features/profile/server.ts'),
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
    read('features/learning/policy-error.ts'),
    read('components/quiz/quiz-client.tsx'),
  ]);
  assert.match(page, /getProfileAvatarUrl\(context\.user\.id\)/);
  assert.doesNotMatch(page, /profile\.onboarding_completed_at && profile\.avatar_updated_at/);
  assert.match(page, /profile\.onboarding_completed_at && avatarUrl/);
  assert.match(profileServer, /rpc\('get_my_profile_avatar_manifest'\)/);
  assert.match(migration, /create table private\.profile_avatar_manifests/);
  assert.match(
    migration,
    /create or replace function public\.complete_profile_onboarding[\s\S]*private\.profile_avatar_manifests/,
  );
  assert.match(
    migration,
    /complete_profile_onboarding[\s\S]*manifest\.legacy_imported[\s\S]*\/avatar\.webp/,
  );
  assert.match(policy, /'AVATAR_REQUIRED'/);
  assert.match(quiz, /payload\.error === 'AVATAR_REQUIRED'/);
});

test('public contact surfaces expose phone and WhatsApp without an email address', async () => {
  const files = await Promise.all(
    [
      'lib/constants.ts',
      'lib/site-contacts.ts',
      'lib/site-contacts-shared.ts',
      'lib/seo.ts',
      'components/layout/footer.tsx',
      'components/legal/legal-contacts.tsx',
      'components/marketing/contact-cta.tsx',
      'app/(public)/contacts/page.tsx',
    ].map(read),
  );
  const source = files.join('\n');
  assert.match(source, /\+7 701 729 0349/);
  assert.match(source, /whatsappE164: '\+77017290349'/);
  assert.match(source, /https:\/\/wa\.me\//);
  assert.doesNotMatch(source, /mailto:/);
  assert.doesNotMatch(source, /work-safety@mail\.ru/);
  assert.doesNotMatch(source, /CONTACTS\.email/);
});
