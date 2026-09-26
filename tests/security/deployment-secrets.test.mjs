import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertDeploymentRuntimeSecrets } from '../../lib/security/deployment-secrets.ts';

const long = (name) => `${name}-${'x'.repeat(40)}`;

const complete = {
  RATE_LIMIT_HMAC_SECRET: long('rate-limit'),
  CERTIFICATE_VERIFICATION_SECRET: long('certificate'),
  SUPABASE_SECRET_KEY: long('sb_secret'),
  SUPABASE_SEND_EMAIL_HOOK_SECRETS: long('v1,whsec_'),
};

test('local builds and CI are left alone', () => {
  // The disposable stacks supply their own throwaway values, and VERCEL_ENV is
  // set by Vercel alone — asserting here would only break `next build` locally.
  assert.doesNotThrow(() => assertDeploymentRuntimeSecrets({}));
  assert.doesNotThrow(() => assertDeploymentRuntimeSecrets({ VERCEL_ENV: 'development' }));
});

test('a complete deployment environment passes', () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    assert.doesNotThrow(() => assertDeploymentRuntimeSecrets({ VERCEL_ENV, ...complete }));
  }
});

test('a deployment missing the quota salt is refused', () => {
  for (const VERCEL_ENV of ['production', 'preview']) {
    assert.throws(
      () =>
        assertDeploymentRuntimeSecrets({
          VERCEL_ENV,
          CERTIFICATE_VERIFICATION_SECRET: complete.CERTIFICATE_VERIFICATION_SECRET,
        }),
      (error) => {
        assert.match(error.message, /RATE_LIMIT_HMAC_SECRET/);
        assert.match(error.message, new RegExp(VERCEL_ENV));
        // The message has to say what to do, not merely what is wrong.
        assert.match(error.message, /vercel env add/);
        return true;
      },
    );
  }
});

test('a deployment missing the certificate signing secret is refused', () => {
  assert.throws(
    () =>
      assertDeploymentRuntimeSecrets({
        VERCEL_ENV: 'production',
        RATE_LIMIT_HMAC_SECRET: complete.RATE_LIMIT_HMAC_SECRET,
      }),
    /CERTIFICATE_VERIFICATION_SECRET/,
  );
});

test('a deployment missing the service-role key or the email hook secret is refused', () => {
  for (const [VERCEL_ENV, names] of [
    ['production', ['SUPABASE_SECRET_KEY', 'SUPABASE_SEND_EMAIL_HOOK_SECRETS']],
    ['preview', ['SUPABASE_SECRET_KEY']],
  ]) {
    for (const name of names) {
      const environment = { VERCEL_ENV, ...complete };
      delete environment[name];
      assert.throws(
        () => assertDeploymentRuntimeSecrets(environment),
        new RegExp(`missing: ${name}`),
      );
    }
  }
  // Preview never receives the Auth email hook, so it builds without its secret.
  const preview = { VERCEL_ENV: 'preview', ...complete };
  delete preview.SUPABASE_SEND_EMAIL_HOOK_SECRETS;
  assert.doesNotThrow(() => assertDeploymentRuntimeSecrets(preview));
  // CI's application job builds with VERCEL_ENV unset and neither value set.
  assert.doesNotThrow(() =>
    assertDeploymentRuntimeSecrets({
      RATE_LIMIT_HMAC_SECRET: complete.RATE_LIMIT_HMAC_SECRET,
      CERTIFICATE_VERIFICATION_SECRET: complete.CERTIFICATE_VERIFICATION_SECRET,
    }),
  );
});

test('a secret too short to be an HMAC key is refused', () => {
  // Both consumers reject anything under 32 characters at request time, so a
  // shorter value would deploy and then fail exactly like a missing one.
  assert.throws(
    () =>
      assertDeploymentRuntimeSecrets({
        VERCEL_ENV: 'production',
        ...complete,
        RATE_LIMIT_HMAC_SECRET: 'too-short',
      }),
    /shorter than 32 characters: RATE_LIMIT_HMAC_SECRET/,
  );
});

test('whitespace does not count as a value', () => {
  assert.throws(
    () => assertDeploymentRuntimeSecrets({ VERCEL_ENV: 'production', ...complete, RATE_LIMIT_HMAC_SECRET: '   ' }),
    /missing: RATE_LIMIT_HMAC_SECRET/,
  );
});

test('the build actually runs the assertion', () => {
  // Without this call the module is dead code and the deployment guard silently
  // disappears — the same failure mode the guard exists to prevent.
  const config = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');
  assert.match(config, /assertDeploymentRuntimeSecrets\(\)/);
  assert.match(config, /from '\.\/lib\/security\/deployment-secrets'/);
});
