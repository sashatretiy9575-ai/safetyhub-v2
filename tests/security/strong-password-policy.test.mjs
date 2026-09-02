import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { emailOtpStartSchema, emailOtpVerifySchema } from '../../lib/validation/auth.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('passwordless verification rejects browser mode and requires the compact legal acknowledgement', () => {
  assert.deepEqual(
    emailOtpStartSchema.parse({ email: 'learner@example.com', intent: 'register' }),
    { email: 'learner@example.com' },
  );
  assert.deepEqual(
    emailOtpVerifySchema.parse({
      email: 'learner@example.com',
      code: '123456',
      intent: 'register',
      legalAccepted: true,
    }),
    { email: 'learner@example.com', code: '123456', legalAccepted: true },
  );
  assert.equal(
    emailOtpVerifySchema.safeParse({
      email: 'learner@example.com',
      code: '123456',
      legalAccepted: false,
    }).success,
    false,
  );
});

test('browser-facing entry pages have no password fields and route through the email-code flow', async () => {
  const [login, registration, flow, requestRoute, verifyRoute] = await Promise.all([
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
    read('features/auth/email-otp-flow.tsx'),
    read('app/api/auth/email-otp/request/route.ts'),
    read('app/api/auth/email-otp/verify/route.ts'),
  ]);
  for (const source of [login, registration, flow]) {
    assert.doesNotMatch(source, /PasswordInput|type="password"|reset-password|change-password/u);
  }
  assert.match(login, /<EmailOtpFlow \/>/u);
  assert.doesNotMatch(login, /intent=/u);
  assert.match(registration, /redirect\(localizePathname\('\/auth\/login', locale\)\)/u);
  assert.doesNotMatch(registration, /<EmailOtpFlow|intent=/u);
  assert.match(requestRoute, /signInWithOtp/u);
  assert.doesNotMatch(requestRoute, /signInWithPassword|auth\.signUp\(/u);
  assert.match(verifyRoute, /verifyOtp/u);
  assert.doesNotMatch(verifyRoute, /signInWithPassword|updateUser\(\{[\s\S]*password/u);
});

test('local Auth configuration sends six-digit email OTPs for both login and registration', async () => {
  const [config, loginTemplate, confirmationTemplate] = await Promise.all([
    read('supabase/config.toml'),
    read('supabase/templates/magic-link.html'),
    read('supabase/templates/confirmation.html'),
  ]);
  assert.match(config, /\[auth\][\s\S]*?enable_signup = true/u);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_signup = true/u);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_confirmations = true/u);
  assert.match(config, /^otp_length = 6$/mu);
  assert.match(config, /^otp_expiry = 3600$/mu);
  assert.match(config, /\[auth\.email\.template\.magic_link\]/u);
  assert.match(config, /\[auth\.email\.template\.confirmation\]/u);
  for (const template of [loginTemplate, confirmationTemplate]) {
    assert.match(template, /\{\{ \.Token \}\}/u);
    assert.doesNotMatch(template, /ConfirmationURL/u);
  }
});
