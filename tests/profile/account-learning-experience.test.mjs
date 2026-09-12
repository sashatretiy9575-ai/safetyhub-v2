import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('avatar is square, privately staged, and published only through its manifest', async () => {
  const [compressor, uploader, route, profileServer, layout] = await Promise.all([
    read('lib/profile/avatar-image.ts'),
    read('components/profile/avatar-uploader.tsx'),
    read('app/api/profile/avatar/route.ts'),
    read('server/profile/dashboard.ts'),
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
    read('server/profile/dashboard.ts'),
    read('components/profile/profile-form.tsx'),
  ]);
  assert.match(profile, /getTranslations\(\{ locale, namespace: 'Profile' \}\)/);
  assert.match(profile, /getPrivateRequestLocale\(\)/);
  assert.match(profile, /t\('dashboardTitle'\)/);
  assert.match(profile, /t\('nextStep'\)/);
  assert.match(profile, /t\('coursesTitle'\)/);
  assert.match(profile, /t\('coursesSummary', \{/);
  assert.match(profile, /t\('download'\)/);
  assert.match(profile, /compact/);
  assert.match(profile, /t\('myData'\)/);
  assert.match(profile, /data-learning-dashboard data-state="ready"/);
  assert.match(profile, /data-learning-dashboard data-state="failed"/);
  assert.doesNotMatch(profile, /Лучшие результаты|Ваше обучение|Данные для сертификата/);
  assert.match(server, /getProfileDashboard/);
  assert.match(server, /rpc\('get_profile_dashboard_locale', \{/);
  assert.match(server, /p_locale: locale/);
  assert.doesNotMatch(profile, /PassRateChart|ActivityChart|ResultDistribution|RecentAttempts/);
  assert.doesNotMatch(profile, /количество попыток|Осталось попыток|Последние попытки/i);
  assert.doesNotMatch(form, /\/api\/identity|supabase\/client/);
});

test('account deletion is explicit, irreversible, and completes inside the request', async () => {
  const [control, route, auth, cleanup, sweep, otpRequest, migration, gateway] =
    await Promise.all([
      read('components/profile/account-deletion.tsx'),
      read('app/api/profile/account/route.ts'),
      read('server/auth/session.ts'),
      read('lib/supabase/session-cleanup.ts'),
      read('server/auth/pending-self-deletion.ts'),
      read('app/api/auth/email-otp/request/route.ts'),
      read('supabase/migrations/20260912100000_immediate_self_account_purge.sql'),
      read('supabase/migrations/20260912182000_auth_email_outbox_and_otp_gateway.sql'),
    ]);
  assert.match(control, /confirmation !== confirmationPhrase/);
  assert.match(control, /body: JSON\.stringify\(\{ confirmation: API_CONFIRMATION \}\)/);
  assert.match(control, /useTranslations\('AccountDeletion'\)/);
  assert.match(control, /t\('description'\)/);
  // The staged worker only marked the account and nothing ever ran the purge:
  // the auth user survived and a later sign-in with the same email failed on
  // the first profile read. The owner's decision is one transaction, now.
  assert.match(route, /rpc\('self_purge_user_account'/);
  assert.doesNotMatch(route, /rpc\('begin_user_account_purge'|rpc\('purge_user_account'/);
  assert.match(route, /requireAccountDeletionUser\(\)/);
  assert.doesNotMatch(route, /p_target_id:\s*(?:body|request|params|searchParams)/);
  // Storage bytes are not part of the transaction: swept best-effort after it.
  assert.match(route, /removeAvatarPrefix\(admin, context\.user\.id\)\.catch/);
  assert.doesNotMatch(route, /storage\.from|\.remove\(/);
  assert.match(route, /LAST_ACTIVE_ADMIN_PROTECTED/);
  assert.match(
    migration,
    /grant execute on function public\.self_purge_user_account\(uuid\) to service_role;/,
  );
  assert.match(migration, /message = 'LAST_ACTIVE_ADMIN_PROTECTED'/);
  assert.match(migration, /'user\.self_purged'/);
  // Accounts the old path left pending are finished before an OTP goes out,
  // so the sign-in creates a brand-new account rather than reviving the old one.
  // The database side of the sweep now lives inside the OTP gateway call and
  // never blocks the sign-in; the route only sweeps leftover avatar bytes.
  assert.match(gateway, /v_purge := public\.purge_pending_self_deletion\(p_email\);/);
  assert.match(gateway, /exception when others then\s*\n\s*v_purge := null;/);
  assert.match(sweep, /removeAvatarPrefix\(admin, userId\)/);
  assert.doesNotMatch(sweep, /purge_pending_self_deletion/);
  assert.match(migration, /and control\.deletion_pending\s*\n\s*order by/);
  assert.ok(
    otpRequest.indexOf('await beginEmailOtpRequest(security.ipHash, parsed.data.email)') <
      otpRequest.indexOf('auth.signInWithOtp({'),
    'the sweep runs before the provider creates or resends for the address',
  );
  assert.match(otpRequest, /sweepPurgedAccountStorage\(purgedUserId\)/);

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

  assert.match(route, /purgeOutcome\(data, context\.user\.id\)/);
  assert.match(route, /NextResponse\.json\(\{ deleted: true \}, \{ status: 200 \}\)/);
  assert.doesNotMatch(route, /tombstoneId|cleanupNotBefore/);
  assert.match(control, /receipt\?\.deleted !== true/);
  assert.match(control, /\?accountDeleted=1/);
  assert.match(route, /clearSafetyHubLocalSession\(request, response\)/);
  assert.match(cleanup, /safetyhub-session-hint/);
  assert.match(cleanup, /Clear-Site-Data/);
});
