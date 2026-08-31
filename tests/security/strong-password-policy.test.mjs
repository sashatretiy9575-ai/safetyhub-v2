import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
  signUpSchema,
  updatePasswordSchema,
} from '../../lib/validation/auth.ts';

const valid = 'SafetyHub2026';

test('registration, recovery, invite and current-password changes share one strong policy', () => {
  assert.equal(PASSWORD_MIN_CHARACTERS, 12);
  assert.equal(PASSWORD_MAX_CHARACTERS, 72);
  assert.equal(
    signUpSchema.safeParse({
      email: 'learner@example.com',
      password: valid,
      passwordConfirm: valid,
      legalAccepted: true,
    }).success,
    true,
  );
  assert.equal(
    updatePasswordSchema.safeParse({ password: valid, passwordConfirm: valid }).success,
    true,
  );

  for (const password of ['shortA1', 'alllowercase2026', 'ALLUPPERCASE2026', 'NoDigitsHereXX']) {
    assert.equal(
      updatePasswordSchema.safeParse({ password, passwordConfirm: password }).success,
      false,
      password,
    );
  }
});

test('password UI uses shared limits and the current-password path enforces Auth reauthentication', async () => {
  const [registration, passwordChange, passwordRoute] = await Promise.all([
    readFile(new URL('../../app/(account)/auth/register/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../features/auth/password-change-form.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/api/auth/password/route.ts', import.meta.url), 'utf8'),
  ]);
  for (const source of [registration, passwordChange]) {
    assert.match(source, /minLength=\{PASSWORD_MIN_CHARACTERS\}/u);
    assert.match(source, /maxLength=\{PASSWORD_MAX_CHARACTERS\}/u);
    assert.match(source, /Минимум 12 символов/u);
  }
  assert.match(passwordRoute, /current_password:\s*parsed\.data\.currentPassword/u);
  const contextBranch = passwordRoute.slice(passwordRoute.indexOf('const session ='));
  assert.doesNotMatch(contextBranch, /current_password/u);
});

test('the direct Supabase Auth boundary enforces the same password policy', async () => {
  const config = await readFile(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(config, /^minimum_password_length = 12$/mu);
  assert.match(config, /^password_requirements = "lower_upper_letters_digits"$/mu);
  assert.match(config, /^secure_password_change = true$/mu);
});
