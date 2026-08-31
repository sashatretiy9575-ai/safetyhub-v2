import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('registration asks only for credentials and defers verified identity', async () => {
  const [register, registerRoute, signupLegal, validation] = await Promise.all([
    read('app/(account)/auth/register/page.tsx'),
    read('app/api/auth/register/route.ts'),
    read('features/auth/signup-legal.ts'),
    read('lib/validation/auth.ts'),
  ]);

  assert.doesNotMatch(register, /firstName|lastName|profile-job/);
  assert.match(register, /signUpSchema\.safeParse/);
  assert.match(register, /clientRequest\('\/api\/auth\/register'/);
  assert.match(registerRoute, /auth\.signUp/);
  assert.match(registerRoute, /emailRedirectTo/);
  assert.match(registerRoute, /if \(error && !isExistingAccountSignupError\(error\)\)/);
  assert.match(registerRoute, /throw error/);
  assert.match(registerRoute, /prepareSignupLegalOperation\(parsed\.data\.email\)/);
  assert.match(registerRoute, /finalizeSignupLegalOperation\(operation, data\.user\.id\)/);
  assert.match(
    registerRoute,
    /data:\s*\{\s*safetyhubSignupOperationId: operation\.operationId,\s*safetyhubSignupNonce: operation\.signupNonce,?\s*\}/s,
  );
  assert.doesNotMatch(
    registerRoute,
    /raw_user_meta_data|legalAcceptance|\.identities\b|deleteUser\(|mark_signup_legal_acceptance/,
  );
  assert.match(signupLegal, /p_privacy_version:\s*PRIVACY_POLICY\.version/);
  assert.match(signupLegal, /p_terms_version:\s*TERMS_POLICY\.version/);
  assert.doesNotMatch(registerRoute, /data:\s*\{\s*(?:name|surname|job):/);
  assert.match(validation, /export const signUpSchema = z[\s\S]*email:[\s\S]*passwordConfirm:/);
  assert.doesNotMatch(validation, /firstName|lastName/);
});

test('registration success explains repeated signup without exposing account existence', async () => {
  const register = await read('app/(account)/auth/register/page.tsx');

  assert.match(register, /Если для этого email ещё нет аккаунта/);
  assert.match(register, /Если аккаунт уже существует, войдите или восстановите пароль/);
  assert.match(register, /href="\/auth\/login"/);
  assert.match(register, /href="\/auth\/reset-password"/);
  assert.doesNotMatch(register, /Проверьте почту и подтвердите регистрацию/);
});

test('auth forms expose inline errors and focus the first invalid field', async () => {
  const [register, login, reset, passwordChange, controls] = await Promise.all([
    read('app/(account)/auth/register/page.tsx'),
    read('app/(account)/auth/login/page.tsx'),
    read('features/auth/password-recovery-flow.tsx'),
    read('features/auth/password-change-form.tsx'),
    read('features/auth/form-controls.tsx'),
  ]);

  for (const source of [register, login, reset, passwordChange]) {
    assert.match(source, /noValidate/);
    assert.match(source, /FieldError/);
    assert.match(source, /requestAnimationFrame/);
    assert.match(source, /aria-describedby/);
  }
  assert.match(controls, /role="alert"/);
  assert.match(controls, /forwardRef<HTMLInputElement/);
});

test('mobile fields prevent zoom and passwords have accessible visibility controls', async () => {
  const [input, textarea, controls] = await Promise.all([
    read('components/ui/input.tsx'),
    read('components/ui/textarea.tsx'),
    read('features/auth/form-controls.tsx'),
  ]);

  assert.match(input, /text-base[\s\S]*sm:text-sm/);
  assert.match(textarea, /text-base[\s\S]*sm:text-sm/);
  assert.match(input, /aria-invalid=\{invalid \|\| undefined\}/);
  assert.match(textarea, /aria-invalid=\{invalid \|\| undefined\}/);
  assert.match(controls, /aria-pressed=\{visible\}/);
  assert.match(controls, /aria-label=\{visible/);
  assert.match(controls, /min-h-11 min-w-11/);
});

test('login and registration enforce configured Turnstile at the server boundary', async () => {
  const [loginRoute, registerRoute] = await Promise.all([
    read('app/api/auth/login/route.ts'),
    read('app/api/auth/register/route.ts'),
  ]);

  for (const route of [loginRoute, registerRoute]) {
    assert.match(route, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
    assert.match(route, /!parsed\.data\.captchaToken/);
    assert.match(route, /INVALID_REQUEST/);
  }
});
