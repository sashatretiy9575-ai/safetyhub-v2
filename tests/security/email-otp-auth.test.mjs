import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { emailOtpStartSchema, emailOtpVerifySchema } from '../../lib/validation/auth.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('email OTP validation normalizes email and accepts exactly six ASCII digits', () => {
  assert.deepEqual(
    emailOtpStartSchema.parse({
      email: ' Learner@Example.COM ',
      intent: 'register',
    }),
    { email: 'learner@example.com', intent: 'register' },
  );
  assert.deepEqual(
    emailOtpVerifySchema.parse({
      email: ' Learner@Example.COM ',
      code: '123456',
      intent: 'login',
      legalAccepted: true,
    }),
    { email: 'learner@example.com', code: '123456' },
  );

  for (const code of ['12345', '1234567', '12 3456', 'abcdef', '１２３４５６', '١٢٣٤٥٦']) {
    assert.equal(
      emailOtpVerifySchema.safeParse({
        email: 'learner@example.com',
        code,
      }).success,
      false,
      code,
    );
  }

  for (const locale of ['ru', 'kk', 'en']) {
    assert.equal(
      emailOtpStartSchema.safeParse({
        email: 'learner@example.com',
        intent: 'login',
        locale,
      }).success,
      true,
      locale,
    );
  }
  assert.equal(
    emailOtpStartSchema.safeParse({
      email: 'learner@example.com',
      intent: 'login',
      locale: 'zh',
    }).success,
    false,
    'Chinese authentication must not enter the email flow',
  );
});

test('email OTP request is origin-bound, provider-proven, and issues an opaque receipt', async () => {
  const [
    route,
    challenge,
    migration,
    generatedTypes,
    appTypes,
    config,
    envExample,
    ci,
    loginTemplate,
    confirmationTemplate,
  ] =
    await Promise.all([
      read('app/api/auth/email-otp/request/route.ts'),
      read('lib/security/email-otp-challenge.ts'),
      read('supabase/migrations/20260901108000_security_boundary_hardening.sql'),
      read('lib/supabase/database.generated.ts'),
      read('lib/supabase/types.ts'),
      read('supabase/config.toml'),
      read('.env.example'),
      read('.github/workflows/ci.yml'),
      read('supabase/templates/magic-link.html'),
      read('supabase/templates/confirmation.html'),
    ]);

  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(route, /readJsonBody\(request\)/u);
  assert.match(route, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
  assert.match(route, /consumeCoarseQuota\('auth\.otp\.start', security\.ipHash\)/u);
  assert.doesNotMatch(route, /auth\.otp\.start\.email|requestSubjectHash/u);
  assert.match(route, /createEphemeralAuthClient\(\)\.auth\.signInWithOtp\(/u);
  assert.match(route, /shouldCreateUser: true/u);
  assert.doesNotMatch(route, /shouldCreateUser: parsed\.data\.intent/u);
  assert.match(route, /captchaToken: parsed\.data\.captchaToken/u);
  assert.match(route, /const locale = parsed\.data\.locale \?\? 'ru'/u);
  assert.match(
    route,
    /emailRedirectTo: emailOtpRedirectUrl\(resolveSiteOrigin\(\), locale\)/u,
  );
  assert.match(route, /authProviderRetryAfter\(error\)/u);
  assert.match(route, /\{ error: 'RATE_LIMITED', retryAfter \}/u);
  assert.match(route, /'Retry-After': String\(retryAfter\)/u);
  assert.match(route, /challengeToken = await issueEmailOtpChallenge\(parsed\.data\.email\)/u);
  assert.ok(
    route.indexOf('auth.signInWithOtp({') < route.indexOf('await issueEmailOtpChallenge('),
    'the provider must accept CAPTCHA/send before the email-bound receipt is issued',
  );
  assert.match(route, /if \(failure\) return failure/u);
  assert.match(route, /setEmailOtpChallengeCookie\([\s\S]*NextResponse\.json\(\{ sent: true \}, \{ status: 202 \}\)/u);
  assert.doesNotMatch(route, /siteverify|challenges\.cloudflare\.com|fetch\(/u);
  assert.doesNotMatch(
    route,
    /prepareSignupLegalOperation|createAdminClient|auth\.admin\.createUser|email_confirm|signInWithPassword|auth\.signUp\(|requestSubjectHash/u,
  );
  assert.match(challenge, /randomBytes\(32\)\.toString\('base64url'\)/u);
  assert.match(challenge, /createHmac\('sha256', challengeHmacSecret\(\)\)/u);
  assert.match(challenge, /safetyhub:email-otp-challenge:v1:\$\{kind\}/u);
  assert.match(challenge, /httpOnly: true/u);
  assert.match(challenge, /secure: process\.env\.NODE_ENV === 'production'/u);
  assert.match(challenge, /sameSite: 'lax'/u);
  assert.match(challenge, /EMAIL_OTP_CHALLENGE_MAX_AGE_SECONDS = 3600/u);
  assert.match(challenge, /rpc\('issue_email_otp_challenge'/u);
  assert.match(migration, /create table private\.email_otp_challenges/u);
  assert.match(migration, /max_attempts smallint not null default 6/u);
  assert.match(migration, /expires_at <= issued_at \+ interval '1 hour'/u);
  assert.match(migration, /create function public\.issue_email_otp_challenge/u);
  assert.match(migration, /grant execute on function public\.issue_email_otp_challenge[\s\S]*to service_role/u);
  for (const typeSource of [generatedTypes, appTypes]) {
    assert.match(typeSource, /issue_email_otp_challenge:/u);
    assert.match(typeSource, /p_expires_in_seconds\?: number/u);
    assert.match(typeSource, /consume_email_otp_challenge_attempt:/u);
    assert.match(typeSource, /complete_email_otp_challenge:/u);
    assert.match(typeSource, /prune_email_otp_challenges:/u);
  }
  assert.match(generatedTypes, /email_otp_challenges: \{[\s\S]*challenge_hash: string/u);
  assert.match(config, /\[auth\][\s\S]*?enable_signup = true/u);
  assert.match(config, /\[auth\.rate_limit\][\s\S]*?email_sent = 30/u);
  assert.match(config, /\[auth\.captcha\][\s\S]*?enabled = true/u);
  assert.match(config, /\[auth\.captcha\][\s\S]*?provider = "turnstile"/u);
  assert.match(config, /secret = "env\(SUPABASE_AUTH_CAPTCHA_SECRET\)"/u);
  assert.match(envExample, /SUPABASE_AUTH_CAPTCHA_SECRET=1x0{31}AA/u);
  assert.match(ci, /SUPABASE_AUTH_CAPTCHA_SECRET: 1x0{31}AA/u);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_signup = true/u);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_confirmations = true/u);
  assert.match(config, /\[auth\.email\][\s\S]*?max_frequency = "1m"/u);
  assert.match(config, /\[auth\.email\][\s\S]*?otp_length = 6/u);
  assert.match(config, /\[auth\.email\][\s\S]*?otp_expiry = 3600/u);
  assert.match(config, /\[auth\.email\.template\.magic_link\]/u);
  assert.match(config, /\[auth\.email\.template\.confirmation\]/u);
  for (const template of [loginTemplate, confirmationTemplate]) {
    assert.match(template, /\{\{ \.Token \}\}/u);
    assert.match(template, /\.RedirectTo/u);
    assert.match(template, /https:\/\/safetyhub\.kz\/en\/auth\/login\?email_locale=en/u);
    assert.match(template, /https:\/\/safetyhub\.kz\/kk\/auth\/login\?email_locale=kk/u);
    assert.doesNotMatch(template, /email_locale=zh|<html lang="zh"/u);
    assert.doesNotMatch(template, /ConfirmationURL/u);
  }
});

test('email OTP verification spends only its bound receipt before provider proof', async () => {
  const [route, challenge, ephemeralClient, migration] = await Promise.all([
    read('app/api/auth/email-otp/verify/route.ts'),
    read('lib/security/email-otp-challenge.ts'),
    read('lib/supabase/ephemeral-auth.ts'),
    read('supabase/migrations/20260901108000_security_boundary_hardening.sql'),
  ]);

  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(route, /readJsonBody\(request\)/u);
  assert.match(route, /consumeCoarseQuota\('auth\.otp\.verify', security\.ipHash\)/u);
  assert.doesNotMatch(route, /auth\.otp\.verify\.email|requestSubjectHash/u);
  assert.match(route, /readEmailOtpChallengeCookie\(request\)/u);
  assert.match(route, /consumeEmailOtpChallengeAttempt\(challengeToken, parsed\.data\.email\)/u);
  assert.ok(
    route.indexOf('await consumeEmailOtpChallengeAttempt(') < route.indexOf('verifier.auth.verifyOtp({'),
    'the challenge attempt must be consumed before provider verification',
  );
  assert.match(
    route,
    /verifyOtp\(\{[\s\S]*email: parsed\.data\.email,[\s\S]*token: parsed\.data\.code,[\s\S]*type: 'email'/u,
  );
  assert.match(route, /user\.email\.trim\(\)\.toLowerCase\(\) !== parsed\.data\.email/u);
  assert.match(route, /completeEmailOtpChallenge\([\s\S]*challengeToken,[\s\S]*parsed\.data\.email/u);
  assert.ok(
    route.indexOf('challengeCompleted = await completeEmailOtpChallenge(') <
      route.indexOf('const supabase = await createClient()'),
    'the receipt must be durably invalidated before session persistence',
  );
  assert.match(route, /clearEmailOtpChallengeCookie\(/u);
  assert.match(
    route,
    /auth\.setSession\(\{[\s\S]*access_token: session\.access_token,[\s\S]*refresh_token: session\.refresh_token/u,
  );
  assert.match(route, /persisted\.data\.user\?\.id !== user\.id/u);
  assert.match(
    route,
    /context\.has_current_legal_acceptance !== true\)[\s\S]*localizedAccountPath\('\/auth\/legal', locale\)/u,
  );
  assert.match(route, /rpc\('set_preferred_locale', \{ p_locale: locale \}\)/u);
  assert.match(route, /auth\.updateUser\(\{ data: \{ preferred_locale: locale \} \}\)/u);
  assert.match(route, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/u);
  assert.match(route, /authProviderRetryAfter\(error\)/u);
  assert.match(route, /\{ error: 'RATE_LIMITED', retryAfter \}/u);
  assert.match(route, /'Retry-After': String\(retryAfter\)/u);
  assert.doesNotMatch(
    route,
    /signInWithPassword|passwordContext|password_ticket|createAdminClient|finalizeSignupLegalOperation|accept_current_legal_documents|legalAccepted|parsed\.data\.intent|requestSubjectHash/u,
  );
  assert.match(ephemeralClient, /persistSession: false/u);
  assert.match(ephemeralClient, /detectSessionInUrl: false/u);
  assert.match(challenge, /rpc\('consume_email_otp_challenge_attempt'/u);
  assert.match(challenge, /rpc\('complete_email_otp_challenge'/u);
  assert.match(migration, /create function public\.consume_email_otp_challenge_attempt/u);
  assert.match(migration, /create function public\.complete_email_otp_challenge/u);
  assert.match(migration, /attempt_count >= v_challenge\.max_attempts/u);
  assert.match(migration, /'reason', 'exhausted'/u);
  assert.match(migration, /revoke all on table private\.email_otp_challenges[\s\S]*service_role/u);
});

test('passwordless browser form shares a bounded cooldown without storing a code or consent claim', async () => {
  const [flow, login, register] = await Promise.all([
    read('features/auth/email-otp-flow.tsx'),
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
  ]);
  const storedAttempt = flow.slice(
    flow.indexOf('function storeAttempt'),
    flow.indexOf('function clearStoredAttempt'),
  );
  const storedCooldown = flow.slice(
    flow.indexOf('function storeSendCooldown'),
    flow.indexOf('function clearStoredSendCooldown'),
  );

  assert.match(storedAttempt, /JSON\.stringify\(\{[\s\S]*?email,[\s\S]*?sentAt,/u);
  assert.doesNotMatch(storedAttempt, /\bintent\s*:|\bcode\s*:|token|password|legalAccepted/u);
  assert.match(storedCooldown, /JSON\.stringify\(\{[\s\S]*?email,[\s\S]*?retryAt,/u);
  assert.doesNotMatch(storedCooldown, /\bintent\s*:|\bcode\s*:|token|password|legalAccepted/u);
  assert.match(flow, /ATTEMPT_STORAGE_KEY = 'safetyhub-email-otp:attempt'/u);
  assert.match(flow, /SEND_COOLDOWN_STORAGE_KEY = 'safetyhub-email-otp:send-cooldown'/u);
  assert.match(flow, /payload\?\.retryAfter/u);
  assert.match(flow, /headers\.get\('Retry-After'\)/u);
  assert.match(flow, /isOtpRateLimited\(errorCode, result\.response\?\.status\)/u);
  assert.match(flow, /retrySecondsUntil\(sendRetryAt, retryClock\)/u);
  assert.match(flow, /visibilitychange/u);
  assert.match(flow, /pageshow/u);
  assert.match(flow, /inFlightActionRef\.current/u);
  assert.match(flow, /autoComplete="one-time-code"/u);
  assert.match(flow, /inputMode="numeric"/u);
  assert.match(flow, /replace\(\/\\D\/gu, ''\)\.slice\(0, 6\)/u);
  assert.match(flow, /pendingCaptchaSubmitRef\.current = \(token\) => void sendCode\(/u);
  assert.match(flow, /value === localizePathname\('\/auth\/legal', locale\)/u);
  assert.match(flow, /locale,/u);
  for (const source of [login, register]) {
    assert.match(source, /<EmailOtpFlow intent=/u);
    assert.doesNotMatch(source, /PasswordInput|type="password"|reset-password/u);
  }
});
