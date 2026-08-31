import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('provider-level Auth hook permits only email-code session issuance', async () => {
  const [migration, schemaUsageMigration, sqlContract] = await Promise.all([
    read('supabase/migrations/20260831115000_passwordless_auth_provider_guard.sql'),
    read('supabase/migrations/20260831120000_auth_hook_public_schema_usage.sql'),
    read('supabase/tests/passwordless_provider_guard.sql'),
  ]);

  assert.match(
    migration,
    /create or replace function public\.enforce_email_otp_access_token\(event jsonb\)/u,
  );
  assert.match(migration, /array\['email\/signup', 'otp', 'magiclink', 'token_refresh'\]/u);
  assert.match(migration, /message', 'EMAIL_OTP_REQUIRED'/u);
  assert.match(
    migration,
    /revoke all on function public\.enforce_email_otp_access_token\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.enforce_email_otp_access_token\(jsonb\)[\s\S]*?to supabase_auth_admin/u,
  );
  assert.match(
    schemaUsageMigration,
    /grant usage on schema public to supabase_auth_admin/u,
  );

  assert.match(sqlContract, /array\['email\/signup', 'otp', 'magiclink', 'token_refresh'\]/u);
  assert.match(
    sqlContract,
    /array\['password', 'recovery', 'invite', 'oauth', 'anonymous', 'totp'\]/u,
  );
  assert.match(sqlContract, /EMAIL_OTP_REQUIRED/u);
  assert.match(sqlContract, /has_schema_privilege\(\s*'supabase_auth_admin', 'public', 'USAGE'\s*\)/u);
});

test('password recovery and invitation templates are controlled static retirement notices', async () => {
  const [config, recoveryTemplate, inviteTemplate] = await Promise.all([
    read('supabase/config.toml'),
    read('supabase/templates/recovery.html'),
    read('supabase/templates/invite.html'),
  ]);

  assert.match(
    config,
    /\[auth\.email\.template\.recovery\][\s\S]*?content_path = "\.\/supabase\/templates\/recovery\.html"/u,
  );
  assert.match(
    config,
    /\[auth\.email\.template\.invite\][\s\S]*?content_path = "\.\/supabase\/templates\/invite\.html"/u,
  );

  for (const template of [recoveryTemplate, inviteTemplate]) {
    assert.match(template, /не (?:используется|используются)|отключены/u);
    assert.doesNotMatch(
      template,
      /\{\{\s*\.\s*(?:Token|ConfirmationURL|TokenHash|RedirectTo)\s*\}\}/u,
    );
    assert.doesNotMatch(template, /восстановлен(?:ие|ия) пароля|установ(?:ка|ить) пароль/iu);
  }
});

test('local Auth configuration activates the email-OTP access-token hook after migrations', async () => {
  const config = await read('supabase/config.toml');

  assert.match(
    config,
    /\[auth\.hook\.custom_access_token\][\s\S]*?enabled = true[\s\S]*?uri = "pg-functions:\/\/postgres\/public\/enforce_email_otp_access_token"/u,
  );
});

test('operator, hosted-security, and load-test scripts never restore a password credential path', async () => {
  const [operatorSeed, hostedGate, loadHarness] = await Promise.all([
    read('scripts/seed-operator-workspace.mjs'),
    read('scripts/hosted-security-gates.mjs'),
    read('scripts/load-test-supabase.mjs'),
  ]);

  assert.doesNotMatch(operatorSeed, /SAFETYHUB_SEED_PASSWORD|password\s*:/u);
  for (const source of [hostedGate, loadHarness]) {
    assert.match(source, /auth\.admin\.generateLink\(/u);
    assert.match(source, /auth\.verifyOtp\(/u);
    assert.doesNotMatch(source, /signInWithPassword|password\s*:/u);
  }
});
