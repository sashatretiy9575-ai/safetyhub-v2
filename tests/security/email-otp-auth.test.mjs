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
  assert.deepEqual(emailOtpVerifySchema.parse({
    email: ' Learner@Example.COM ',
    code: '123456',
    intent: 'login',
    legalAccepted: true,
  }), { email: 'learner@example.com', code: '123456' });

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
});

test('email OTP request is origin-bound, native, enumeration-neutral, and rate-limited twice', async () => {
  const [route, rateLimit, migration, config, loginTemplate, confirmationTemplate] = await Promise.all([
    read('app/api/auth/email-otp/request/route.ts'),
    read('lib/security/rate-limit.ts'),
    read('supabase/migrations/20260831100000_email_otp_rate_limits.sql'),
    read('supabase/config.toml'),
    read('supabase/templates/magic-link.html'),
    read('supabase/templates/confirmation.html'),
  ]);

  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(route, /readJsonBody\(request\)/u);
  assert.match(route, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
  assert.match(route, /consumeCoarseQuota\('auth\.otp\.start', security\.ipHash\)/u);
  assert.match(
    route,
    /consumeCoarseQuota\('auth\.otp\.start\.email', requestSubjectHash\(parsed\.data\.email\)\)/u,
  );
  assert.match(route, /createEphemeralAuthClient\(\)\.auth\.signInWithOtp\(/u);
  assert.match(route, /shouldCreateUser: true/u);
  assert.doesNotMatch(route, /shouldCreateUser: parsed\.data\.intent/u);
  assert.match(route, /captchaToken: parsed\.data\.captchaToken/u);
  assert.match(route, /return NextResponse\.json\(\{ sent: true \}, \{ status: 202 \}\)/u);
  assert.doesNotMatch(
    route,
    /prepareSignupLegalOperation|createAdminClient|auth\.admin\.createUser|email_confirm|signInWithPassword|auth\.signUp\(/u,
  );
  assert.match(rateLimit, /'auth\.otp\.start'/u);
  assert.match(rateLimit, /'auth\.otp\.start\.email'/u);
  assert.match(migration, /when 'auth\.otp\.start' then 20/u);
  assert.match(migration, /when 'auth\.otp\.start\.email' then 5/u);
  assert.match(migration, /when p_action in \('auth\.otp\.start', 'auth\.otp\.start\.email'\) then 900/u);
  assert.match(config, /\[auth\][\s\S]*?enable_signup = true/u);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_signup = true/u);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_confirmations = true/u);
  assert.match(config, /\[auth\.email\.template\.magic_link\]/u);
  assert.match(config, /\[auth\.email\.template\.confirmation\]/u);
  for (const template of [loginTemplate, confirmationTemplate]) {
    assert.match(template, /\{\{ \.Token \}\}/u);
    assert.doesNotMatch(template, /ConfirmationURL/u);
  }
});

test('email OTP verification proves the exact Auth identity before persisting a session', async () => {
  const [route, ephemeralClient, rateLimit, migration] = await Promise.all([
    read('app/api/auth/email-otp/verify/route.ts'),
    read('lib/supabase/ephemeral-auth.ts'),
    read('lib/security/rate-limit.ts'),
    read('supabase/migrations/20260831100000_email_otp_rate_limits.sql'),
  ]);

  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(route, /readJsonBody\(request\)/u);
  assert.match(route, /consumeCoarseQuota\('auth\.otp\.verify', security\.ipHash\)/u);
  assert.match(
    route,
    /consumeCoarseQuota\('auth\.otp\.verify\.email', requestSubjectHash\(parsed\.data\.email\)\)/u,
  );
  assert.match(
    route,
    /verifyOtp\(\{[\s\S]*email: parsed\.data\.email,[\s\S]*token: parsed\.data\.code,[\s\S]*type: 'email'/u,
  );
  assert.match(route, /user\.email\.trim\(\)\.toLowerCase\(\) !== parsed\.data\.email/u);
  assert.match(route, /auth\.setSession\(\{[\s\S]*access_token: session\.access_token,[\s\S]*refresh_token: session\.refresh_token/u);
  assert.match(route, /persisted\.data\.user\?\.id !== user\.id/u);
  assert.match(route, /if \(context\.has_current_legal_acceptance !== true\) return '\/auth\/legal'/u);
  assert.match(route, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/u);
  assert.doesNotMatch(
    route,
    /signInWithPassword|passwordContext|password_ticket|createAdminClient|finalizeSignupLegalOperation|accept_current_legal_documents|legalAccepted|parsed\.data\.intent/u,
  );
  assert.match(ephemeralClient, /persistSession: false/u);
  assert.match(ephemeralClient, /detectSessionInUrl: false/u);
  assert.match(rateLimit, /'auth\.otp\.verify'/u);
  assert.match(rateLimit, /'auth\.otp\.verify\.email'/u);
  assert.match(migration, /when 'auth\.otp\.verify' then 30/u);
  assert.match(migration, /when 'auth\.otp\.verify\.email' then 6/u);
});

test('passwordless browser form stores only a bounded email attempt, never a code or consent claim', async () => {
  const [flow, login, register] = await Promise.all([
    read('features/auth/email-otp-flow.tsx'),
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
  ]);
  const storedAttempt = flow.slice(
    flow.indexOf('function storeAttempt'),
    flow.indexOf('function clearStoredAttempt'),
  );

  assert.match(storedAttempt, /JSON\.stringify\(\{[\s\S]*?email,[\s\S]*?intent,[\s\S]*?sentAt,/u);
  assert.doesNotMatch(storedAttempt, /\bcode\s*:|token|password|legalAccepted/u);
  assert.match(flow, /autoComplete="one-time-code"/u);
  assert.match(flow, /inputMode="numeric"/u);
  assert.match(flow, /replace\(\/\\D\/gu, ''\)\.slice\(0, 6\)/u);
  assert.match(flow, /pendingCaptchaSubmitRef\.current = \(token\) => void sendCode\(/u);
  assert.match(flow, /value === '\/auth\/legal'/u);
  for (const source of [login, register]) {
    assert.match(source, /<EmailOtpFlow intent=/u);
    assert.doesNotMatch(source, /PasswordInput|type="password"|reset-password/u);
  }
});
