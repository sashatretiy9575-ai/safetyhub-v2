import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('retired Chinese WebAuthn and recovery endpoints are server-side 410 tombstones', async () => {
  const [helper, ...routes] = await Promise.all([
    read('features/auth/zh-passkey-retired.ts'),
    read('app/api/auth/zh/registration/options/route.ts'),
    read('app/api/auth/zh/registration/verify/route.ts'),
    read('app/api/auth/zh/authentication/options/route.ts'),
    read('app/api/auth/zh/authentication/verify/route.ts'),
    read('app/api/auth/zh/recovery/verify/route.ts'),
    read('app/api/admin/users/[userId]/zh-credential/reset/route.ts'),
  ]);

  assert.match(helper, /ZH_AUTH_METHOD_RETIRED/u);
  assert.match(helper, /status: 410/u);
  for (const route of routes) {
    assert.match(route, /zhPasskeyRetiredResponse/u);
    assert.doesNotMatch(
      route,
      /zh-webauthn|simplewebauthn|readJsonBody|createEphemeralAuthClient|console\.(?:log|error)/iu,
    );
  }
});

test('Chinese username/password routes are same-origin, bounded, rate-limited, and generic', async () => {
  const [login, register, reset, provision, server] = await Promise.all([
    read('app/api/auth/zh/login/route.ts'),
    read('app/api/auth/zh/register/route.ts'),
    read('app/api/admin/users/[userId]/zh-password/reset/route.ts'),
    read('app/api/admin/users/[userId]/zh-password/provision/route.ts'),
    read('features/auth/zh-username-password-server.ts'),
  ]);

  for (const route of [login, register]) {
    assert.match(route, /isSameOriginRequest\(request\)/u);
    assert.match(route, /rolloutFeatureEnabled\('zhUsernamePassword'\)/u);
    assert.match(route, /readJsonBody\(request, 8192\)/u);
    assert.match(route, /consumeCoarseQuota/u);
    assert.match(route, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
    assert.match(route, /!parsed\.data\.captchaToken/u);
    assert.doesNotMatch(route, /syntheticEmail|console\.(?:log|error)/u);
  }
  assert.match(login, /ZH_AUTHENTICATION_FAILED/u);
  assert.match(register, /ZH_REGISTRATION_FAILED/u);
  assert.match(login, /auth\.otp\.verify/u);
  assert.match(register, /auth\.register/u);

  for (const route of [reset, provision]) {
    assert.match(route, /invalidOriginResponse\(request\)/u);
    assert.match(route, /entityIdSchema/u);
    assert.match(route, /readJsonBody\(request, 8192\)/u);
    assert.match(route, /admin\.zh_credential\.reset/u);
    assert.doesNotMatch(route, /console\.(?:log|error)/u);
  }
  assert.match(server, /import 'server-only'/u);
  assert.match(server, /get_zh_username_password_rollout_enabled/u);
  assert.match(server, /requireZhUsernamePasswordRollout\('ZH_AUTHENTICATION_FAILED'\)/u);
  assert.match(server, /requireZhUsernamePasswordRollout\('ZH_REGISTRATION_FAILED'\)/u);
  assert.match(server, /begin_zh_username_password_reset/u);
  assert.match(server, /complete_zh_username_password_reset/u);
  assert.match(server, /options: \{ captchaToken \}/u);
  assert.match(server, /performDecoyPasswordAttempt\(input\.password, input\.captchaToken\)/u);
  assert.equal(
    server.match(/persistPasswordSession\(mapping, input\.password, input\.captchaToken\)/gu)
      ?.length,
    1,
  );
  assert.doesNotMatch(server, /console\.(?:log|error)|localStorage|sessionStorage/u);
});

test('Chinese canonical access uses only Latin username and password without client secret persistence', async () => {
  const [flow, loginPage, registerPage, recoveryPage] = await Promise.all([
    read('features/auth/zh-username-password-flow.tsx'),
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
    read('features/auth/zh-username-password-recovery-notice.tsx'),
  ]);

  assert.match(flow, /autoComplete="username"/u);
  assert.match(flow, /type="password"/u);
  assert.match(flow, /current-password/u);
  assert.match(flow, /new-password/u);
  assert.match(flow, /useRef<TurnstileHandle>\(null\)/u);
  assert.match(flow, /captchaToken,/u);
  assert.match(flow, /管理员核验后可协助重设/u);
  assert.doesNotMatch(
    flow,
    /@auth\.invalid|simplewebauthn|localStorage|sessionStorage|one-time-code|type="email"|oauth/iu,
  );
  assert.match(loginPage, /rolloutFeatureEnabled\('zhUsernamePassword'\)/u);
  assert.match(loginPage, /ZhUsernamePasswordFlow/u);
  assert.doesNotMatch(loginPage, /ZhPasskeyFlow|zhPasskey/u);
  assert.match(registerPage, /redirect\(localizePathname\('\/auth\/login', locale\)\)/u);
  assert.doesNotMatch(registerPage, /ZhUsernamePasswordFlow|ZhPasskeyFlow|zhPasskey/u);
  assert.match(recoveryPage, /没有自助恢复渠道/u);
  assert.doesNotMatch(recoveryPage, /type="email"|one-time-code|simplewebauthn/iu);
});

test('server-only mapping redacts the synthetic identifier and never persists passwords', async () => {
  const [migration, server, validation] = await Promise.all([
    read('supabase/migrations/20260902130000_zh_username_password_auth.sql'),
    read('features/auth/zh-username-password-server.ts'),
    read('features/auth/zh-username-password-validation.ts'),
  ]);

  assert.match(migration, /create table private\.zh_username_accounts/u);
  assert.match(migration, /synthetic_email text not null unique/u);
  assert.match(migration, /password_change_pending boolean not null default false/u);
  assert.match(migration, /revoke all on table private\.zh_username_accounts/u);
  assert.match(migration, /jsonb_build_object\('email', '', 'phone', ''\)/u);
  assert.match(migration, /v_authentication_method = 'password'/u);
  assert.match(migration, /v_authentication_method = 'token_refresh'/u);
  assert.match(migration, /ZH_AUTH_METHOD_RETIRED/u);
  assert.match(migration, /from private\.zh_webauthn_accounts legacy_account[\s\S]*return false/u);
  assert.match(migration, /ZH_USERNAME_PASSWORD_ROLLOUT_DISABLED/u);
  assert.match(migration, /'zh_username_password', false/u);
  assert.doesNotMatch(migration, /p_password|password_hash|encrypted_password.*zh_username/u);
  assert.match(server, /randomBytes\(16\)\.toString\('hex'\).*@auth\.invalid/u);
  assert.match(server, /auth\.admin\.createUser/u);
  assert.match(server, /auth\.admin\.updateUserById/u);
  assert.doesNotMatch(server, /console\.(?:log|error)/u);
  assert.match(validation, /zhPasswordSchema/u);
  assert.match(validation, /\.min\(12\)/u);
  assert.match(validation, /\[a-z\]/u);
  assert.match(validation, /\[A-Z\]/u);
  assert.match(validation, /\[0-9\]/u);
  assert.equal(validation.match(/captchaToken: captchaTokenSchema/gu)?.length, 2);
});

test('Chinese registration verifies its separate Turnstile token before allocation and mints a fresh token for auto-login', async () => {
  const [server, verifier, validation, flow, turnstile, loginPage, environment] = await Promise.all(
    [
      read('features/auth/zh-username-password-server.ts'),
      read('features/auth/turnstile-server.ts'),
      read('features/auth/zh-username-password-validation.ts'),
      read('features/auth/zh-username-password-flow.tsx'),
      read('features/auth/turnstile.tsx'),
      read('app/(account)/auth/login/page.tsx'),
      read('.env.example'),
    ],
  );

  const registration = server.slice(
    server.indexOf('export async function registerZhUsernamePassword'),
    server.indexOf('async function updatePasswordAtProvider'),
  );
  const captchaVerification = registration.indexOf('verifyTurnstileRegistrationToken');
  assert.ok(captchaVerification >= 0);
  for (const laterOperation of [
    'getLoginMapping(input.username)',
    'getCurrentLegalPolicies()',
    'createZhRegistrationAuthUser',
    'complete_zh_username_registration',
  ]) {
    assert.ok(
      captchaVerification < registration.indexOf(laterOperation),
      `${laterOperation} must occur after Turnstile verification`,
    );
  }
  assert.match(registration, /const userId = randomUUID\(\)/u);
  assert.match(server, /id: userId/u);
  assert.match(server, /getUserById\(userId\)/u);
  assert.match(registration, /deleteUnmappedZhRegistrationAuthUser/u);
  assert.match(registration, /registered: true as const/u);
  assert.match(registration, /redirectTo: '\/zh\/auth\/login'/u);
  assert.doesNotMatch(registration, /persistPasswordSession|signInWithPassword/u);

  assert.match(verifier, /import 'server-only'/u);
  assert.match(verifier, /SAFETYHUB_TURNSTILE_SECRET_KEY/u);
  assert.match(verifier, /turnstile\/v0\/siteverify/u);
  assert.match(verifier, /cache: 'no-store'/u);
  assert.match(verifier, /new AbortController\(\)/u);
  assert.match(verifier, /result\.success !== true/u);
  assert.match(verifier, /result\.hostname\.toLowerCase\(\) === expectedHostname/u);
  assert.match(verifier, /VERCEL_ENV === 'preview'/u);
  assert.match(verifier, /CLOUDFLARE_ALWAYS_PASS_TEST_SECRET/u);
  assert.doesNotMatch(verifier, /NEXT_PUBLIC_TURNSTILE_SECRET|x-forwarded-for|console\./iu);

  assert.match(validation, /CAPTCHA_TOKEN_MAX_BYTES = 2_048/u);
  assert.match(validation, /ZH_PASSWORD_MAX_BYTES = 72/u);
  assert.match(validation, /new TextEncoder\(\)/u);
  assert.match(flow, /onFailure=\{\(\) => \{[\s\S]*pendingCaptchaSubmitRef\.current = null/u);
  assert.match(flow, /CAPTCHA_RETRY/u);
  assert.match(flow, /maxLength=\{ZH_PASSWORD_MAX_BYTES\}/u);
  assert.match(
    flow,
    /const submitRequest = useCallback\(async \(captchaToken\?: string, requestedMode: Mode = mode\)/u,
  );
  assert.match(
    flow,
    /useEffect\(\(\) => \{[\s\S]*submitRequestRef\.current = \(captchaToken, requestedMode\)/u,
  );
  assert.match(flow, /automaticLoginStarted = true/u);
  assert.match(flow, /useEffect\(\(\) => \{[\s\S]*if \(!autoLoginPending\) return;/u);
  assert.match(
    flow,
    /pendingCaptchaSubmitRef\.current = \(freshToken\) => \{[\s\S]*submitRequestRef\.current\(freshToken, 'login'\)/u,
  );
  assert.match(flow, /window\.setTimeout\([\s\S]*submitRequestRef\.current\(undefined, 'login'\)/u);
  assert.match(flow, /AUTO_LOGIN_FALLBACK/u);
  assert.match(turnstile, /resetRequiredRef\.current \|\| completedRef\.current/u);
  assert.match(turnstile, /window\.turnstile\.reset\(widgetId\)/u);
  assert.doesNotMatch(flow, /useSearchParams/u);
  assert.match(loginPage, /searchParams: Promise/u);
  assert.match(loginPage, /deletionRequested/u);
  assert.doesNotMatch(loginPage, /registrationComplete/u);
  assert.match(environment, /SAFETYHUB_TURNSTILE_SECRET_KEY=1x0{31}AA/u);
});

test('Chinese learners follow the same profile, review and photo admission as everyone else', async () => {
  const [
    migration,
    sqlContract,
    admissionContract,
    server,
    onboarding,
    legal,
    profile,
    queue,
    data,
    appTypes,
    documentation,
  ] = await Promise.all([
    read('supabase/migrations/20260903120000_zh_full_profile_admission.sql'),
    read('supabase/tests/zh_minimal_pending_approval.sql'),
    read('supabase/tests/zh_full_profile_admission.sql'),
    read('features/auth/zh-username-password-server.ts'),
    read('app/(account)/onboarding/page.tsx'),
    read('app/(account)/auth/legal/page.tsx'),
    read('app/(account)/profile/page.tsx'),
    read('components/admin/account-approval-queue.tsx'),
    read('features/admin/data.ts'),
    read('lib/supabase/types.ts'),
    read('docs/zh-username-password-auth.md'),
  ]);

  // Registration creates the credential and the legal acceptance, nothing else.
  assert.match(migration, /create or replace function public\.complete_zh_username_registration/u);
  const controlLock = migration.indexOf('select control.* into v_control');
  const profileLock = migration.indexOf('select profile.* into v_profile');
  assert.ok(
    controlLock >= 0 && profileLock > controlLock,
    'ZH registration must lock account_controls before profiles',
  );
  assert.match(migration, /set preferred_locale = 'zh'/u);
  assert.match(migration, /insert into public\.legal_acceptances/u);
  const registration = migration.slice(
    migration.indexOf('create or replace function public.complete_zh_username_registration'),
    migration.indexOf('create or replace function private.start_test_attempt_unmetered'),
  );
  assert.doesNotMatch(registration, /approval_state = 'pending'/u);
  assert.doesNotMatch(registration, /approval_due_at/u);
  assert.doesNotMatch(registration, /account\.approval_requested/u);
  assert.match(registration, /'approvalRequestedAt', null/u);

  // The single SQL bypass is gone, and so is the helper it depended on.
  assert.match(migration, /create or replace function private\.start_test_attempt_unmetered/u);
  assert.doesNotMatch(migration, /is_approved_zh_username_learner\(v_user_id\)/u);
  assert.match(migration, /drop function private\.is_approved_zh_username_learner\(uuid\)/u);
  assert.match(migration, /PROFILE_ONBOARDING_REQUIRED/u);
  assert.match(migration, /AVATAR_REQUIRED/u);
  // Accounts admitted under the old rule are sent back to the form.
  assert.match(migration, /approval_state = 'profile_incomplete'/u);
  assert.match(migration, /ZH_FULL_PROFILE_ADMISSION_INCOMPLETE/u);
  assert.doesNotMatch(migration, /p_password|password_hash|encrypted_password/u);

  assert.match(sqlContract, /submit_profile_for_approval_from_trusted_server/u);
  assert.match(sqlContract, /approval_due_at[\s\S]*?interval '24 hours'/u);
  assert.match(sqlContract, /v_event_payload \? 'username'/u);
  assert.match(sqlContract, /v_queue_item ->> 'username' <> 'zhminimal001'/u);
  assert.match(sqlContract, /avatarAvailable/u);
  assert.match(sqlContract, /public\.decide_account_approval/u);
  assert.match(sqlContract, /public\.start_test_attempt_locale\(v_test_slug, 'zh'\)/u);
  assert.match(sqlContract, /IDENTITY_NOT_VERIFIED/u);
  assert.match(admissionContract, /the ZH admission bypass function still exists/u);
  assert.match(admissionContract, /PROFILE_ONBOARDING_REQUIRED/u);
  assert.match(admissionContract, /AVATAR_REQUIRED/u);

  // A ZH login now lands on the ordinary onboarding form when no profile exists.
  assert.match(server, /parseIncompleteRegistration/u);
  assert.match(server, /result\.approvalState !== 'profile_incomplete'/u);
  assert.match(server, /profile_onboarding_completed_at === null\) return '\/zh\/onboarding'/u);
  assert.match(server, /approval_state === 'rejected'\) return '\/zh\/profile'/u);
  assert.doesNotMatch(server, /approval_state === 'pending' \|\|/u);
  assert.match(server, /completed\.userId !== userId/u);
  assert.match(appTypes, /ZhUsernamePasswordRegistrationResult/u);
  assert.match(appTypes, /approvalState: 'profile_incomplete'/u);

  // Nothing hides the form from a Chinese learner any more.
  for (const surface of [onboarding, legal, profile]) {
    assert.doesNotMatch(surface, /isZhUsernamePasswordMinimalApplication|isMinimalZhApplication/u);
  }
  assert.match(profile, /needsProfileAction=\{!profile\.organization/u);
  assert.doesNotMatch(queue, /minimalZh|заявка без контактных данных/u);
  // The login stays visible to the reviewer next to the ordinary details.
  assert.match(queue, /item\.username/u);
  assert.match(data, /username: z[\s\S]*?\.regex/u);
  assert.match(documentation, /profile_incomplete/u);
  assert.match(documentation, /certificate remains `pending_identity`/u);
});
