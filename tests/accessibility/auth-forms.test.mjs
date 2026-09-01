import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('registration asks for email only and defers explicit legal consent until after verified identity', async () => {
  const [register, flow, requestRoute, verifyRoute, legalPage, legalGate, validation] = await Promise.all([
    read('app/(account)/auth/register/page.tsx'),
    read('features/auth/email-otp-flow.tsx'),
    read('app/api/auth/email-otp/request/route.ts'),
    read('app/api/auth/email-otp/verify/route.ts'),
    read('app/(account)/auth/legal/page.tsx'),
    read('features/auth/legal-acceptance-gate.tsx'),
    read('lib/validation/auth.ts'),
  ]);

  assert.match(register, /<EmailOtpFlow intent="register"/u);
  assert.doesNotMatch(register, /firstName|lastName|profile-job|PasswordInput|type="password"/u);
  assert.match(flow, /emailOtpStartSchema\.safeParse/u);
  assert.match(flow, /clientRequest\('\/api\/auth\/email-otp\/request'/u);
  assert.match(requestRoute, /createEphemeralAuthClient\(\)\.auth\.signInWithOtp/u);
  assert.match(requestRoute, /shouldCreateUser: true/u);
  assert.doesNotMatch(
    requestRoute,
    /prepareSignupLegalOperation|createAdminClient|auth\.admin\.createUser|email_confirm|raw_user_meta_data|\.identities\b|deleteUser\(/u,
  );
  assert.match(verifyRoute, /return '\/auth\/legal'/u);
  assert.doesNotMatch(verifyRoute, /accept_current_legal_documents|legalAccepted|parsed\.data\.intent/u);
  assert.match(legalPage, /requireUser\(\{ enforceLegal: false \}\)/u);
  assert.match(legalPage, /<LegalAcceptanceGate/u);
  assert.match(legalGate, /<LegalAcceptancePanel/u);
  assert.match(legalGate, /router\.replace\(continueTo\)/u);
  assert.match(validation, /export const emailOtpStartSchema = z[\s\S]*intent/u);
  const verificationSchema = validation.slice(validation.indexOf('export const emailOtpVerifySchema'));
  assert.doesNotMatch(verificationSchema, /intent|legalAccepted/u);
  assert.doesNotMatch(validation, /firstName|lastName/u);
});

test('registration start is neutral about whether the email already has an account', async () => {
  const [flow, requestRoute] = await Promise.all([
    read('features/auth/email-otp-flow.tsx'),
    read('app/api/auth/email-otp/request/route.ts'),
  ]);

  assert.match(flow, /Если этот адрес можно использовать, код отправлен/u);
  assert.match(requestRoute, /return NextResponse\.json\(\{ sent: true \}, \{ status: 202 \}\)/u);
  assert.doesNotMatch(flow, /reset-password|восстановите пароль|Пароль/u);
});

test('email-code form exposes inline errors and focuses the first invalid field', async () => {
  const [flow, controls, input] = await Promise.all([
    read('features/auth/email-otp-flow.tsx'),
    read('features/auth/form-controls.tsx'),
    read('components/ui/input.tsx'),
  ]);

  for (const source of [flow]) {
    assert.match(source, /noValidate/u);
    assert.match(source, /FieldError/u);
    assert.match(source, /requestAnimationFrame/u);
    assert.match(source, /aria-describedby/u);
  }
  assert.match(controls, /role="alert"/u);
  assert.match(input, /forwardRef<HTMLInputElement/u);
  assert.doesNotMatch(flow, /PasswordInput|type="password"/u);
});

test('mobile fields prevent zoom and keep OTP controls accessible', async () => {
  const [input, textarea, flow] = await Promise.all([
    read('components/ui/input.tsx'),
    read('components/ui/textarea.tsx'),
    read('features/auth/email-otp-flow.tsx'),
  ]);

  assert.match(input, /text-base[\s\S]*sm:text-sm/u);
  assert.match(textarea, /text-base[\s\S]*sm:text-sm/u);
  assert.match(input, /aria-invalid=\{invalid \|\| undefined\}/u);
  assert.match(textarea, /aria-invalid=\{invalid \|\| undefined\}/u);
  assert.match(flow, /inputMode="numeric"/u);
  assert.match(flow, /autoComplete="one-time-code"/u);
  assert.match(flow, /pattern="\[0-9\]\{6\}"/u);
  assert.match(flow, /className="min-h-11 w-full"/u);
  assert.doesNotMatch(flow, /aria-pressed|показать пароль|скрыть пароль/iu);
});

test('login and registration enforce configured Turnstile at the OTP server boundary', async () => {
  const [startRoute, verifyRoute] = await Promise.all([
    read('app/api/auth/email-otp/request/route.ts'),
    read('app/api/auth/email-otp/verify/route.ts'),
  ]);

  assert.match(startRoute, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
  assert.match(startRoute, /!parsed\.data\.captchaToken/u);
  assert.match(startRoute, /INVALID_REQUEST/u);
  assert.match(verifyRoute, /isSameOriginRequest\(request\)/u);
  assert.match(verifyRoute, /INVALID_REQUEST/u);
});
