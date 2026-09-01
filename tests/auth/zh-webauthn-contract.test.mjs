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
  assert.match(
    server,
    /performDecoyPasswordAttempt\(input\.password, input\.captchaToken\)/u,
  );
  assert.equal(
    server.match(/persistPasswordSession\(mapping, input\.password, input\.captchaToken\)/gu)
      ?.length,
    1,
  );
  assert.doesNotMatch(server, /console\.(?:log|error)|localStorage|sessionStorage/u);
});

test('Chinese browser entry uses only Latin username and password without client secret persistence', async () => {
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
  for (const page of [loginPage, registerPage]) {
    assert.match(page, /rolloutFeatureEnabled\('zhUsernamePassword'\)/u);
    assert.match(page, /ZhUsernamePasswordFlow/u);
    assert.doesNotMatch(page, /ZhPasskeyFlow|zhPasskey/u);
  }
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
  assert.match(
    migration,
    /from private\.zh_webauthn_accounts legacy_account[\s\S]*return false/u,
  );
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

test('Chinese registration verifies its separate Turnstile token before allocation', async () => {
  const [server, verifier, validation, flow, loginPage, environment] = await Promise.all([
    read('features/auth/zh-username-password-server.ts'),
    read('features/auth/turnstile-server.ts'),
    read('features/auth/zh-username-password-validation.ts'),
    read('features/auth/zh-username-password-flow.tsx'),
    read('app/(account)/auth/login/page.tsx'),
    read('.env.example'),
  ]);

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
  assert.match(flow, /setMessage\(CAPTCHA_RETRY\)/u);
  assert.match(flow, /maxLength=\{ZH_PASSWORD_MAX_BYTES\}/u);
  assert.match(flow, /router\.replace\('\/zh\/auth\/login\?registered=1'\)/u);
  assert.doesNotMatch(flow, /useSearchParams/u);
  assert.match(loginPage, /searchParams: Promise/u);
  assert.match(loginPage, /registrationComplete=\{registrationComplete\}/u);
  assert.match(environment, /SAFETYHUB_TURNSTILE_SECRET_KEY=1x0{31}AA/u);
});
