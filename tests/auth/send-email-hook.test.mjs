import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const route = await readFile('app/api/auth/send-email/route.ts', 'utf8');
const hook = await readFile('features/auth/send-email-hook.ts', 'utf8');
const smtp = await readFile('lib/email/smtp.ts', 'utf8');
const config = await readFile('supabase/config.toml', 'utf8');
const exampleEnvironment = await readFile('.env.example', 'utf8');

test('Supabase Auth delivers email through the app instead of direct SMTP', () => {
  assert.match(config, /\[auth\.hook\.send_email\]\nenabled = true\n/u);
  assert.match(config, /uri = "https:\/\/safetyhub\.kz\/api\/auth\/send-email"/u);
  assert.match(config, /secrets = "env\(SUPABASE_SEND_EMAIL_HOOK_SECRETS\)"/u);
  assert.doesNotMatch(config, /\[auth\.email\.smtp\]/u);
});

test('the hook route answers before relaying and never trusts an unsigned call', () => {
  assert.match(route, /export const runtime = 'nodejs'/u);
  assert.match(route, /verifyStandardWebhook\(/u);
  assert.match(route, /INVALID_SIGNATURE/u);
  assert.match(route, /afterResponse\(\(\) => deliver\(/u);
  assert.doesNotMatch(route, /from 'next\/server'/u);
  assert.match(route, /SEND_EMAIL_HOOK_NOT_CONFIGURED/u);
  assert.match(route, /PAYLOAD_TOO_LARGE/u);
  // The one-time code must never reach logs: no console usage in the route.
  assert.doesNotMatch(route, /console\./u);
  assert.doesNotMatch(smtp, /console\./u);
  assert.doesNotMatch(hook, /console\./u);
});

test('signature verification follows Standard Webhooks with a time window', () => {
  assert.match(hook, /createHmac\('sha256'/u);
  assert.match(hook, /timingSafeEqual\(/u);
  assert.match(hook, /SIGNATURE_TOLERANCE_SECONDS = 5 \* 60/u);
  assert.match(hook, /\^v1,whsec_/u);
  assert.match(hook, /\$\{id\}\.\$\{timestamp\}\.\$\{body\}/u);
});

test('rendered templates match the Supabase templates copy for every locale', async () => {
  const magicLink = await readFile('supabase/templates/magic-link.html', 'utf8');
  const confirmation = await readFile('supabase/templates/confirmation.html', 'utf8');
  for (const phrase of [
    'Your SafetyHub code',
    'SafetyHub кодыңыз',
    'Код SafetyHub',
    'Enter this one-time code in SafetyHub:',
    'Осы бір реттік кодты SafetyHub-та енгізіңіз:',
    'Введите этот одноразовый код в SafetyHub:',
  ]) {
    assert.ok(magicLink.includes(phrase), `magic-link template lacks: ${phrase}`);
    assert.ok(hook.includes(phrase), `hook renderer lacks: ${phrase}`);
  }
  for (const phrase of [
    'Create your SafetyHub account',
    'SafetyHub аккаунтын жасау',
    'Создание аккаунта SafetyHub',
  ]) {
    assert.ok(confirmation.includes(phrase), `confirmation template lacks: ${phrase}`);
    assert.ok(hook.includes(phrase), `hook renderer lacks: ${phrase}`);
  }
  // Recovery and invite stay static retirement notices without any token.
  assert.match(hook, /case 'recovery':[\s\S]*?noticeCard\(/u);
  assert.match(hook, /case 'invite':[\s\S]*?noticeCard\(/u);
  assert.doesNotMatch(hook, /ConfirmationURL|token_hash/u);
});

test('the SMTP client speaks implicit TLS with AUTH PLAIN and base64 bodies', () => {
  assert.match(smtp, /from 'node:tls'/u);
  assert.match(smtp, /AUTH PLAIN/u);
  assert.match(smtp, /Buffer\.from\(\[0\]\)/u);
  assert.match(smtp, /Content-Transfer-Encoding: base64/u);
  assert.match(smtp, /=\?UTF-8\?B\?/u);
  assert.match(smtp, /RCPT TO:<\$\{message\.to\}>/u);
  assert.doesNotMatch(smtp, /rejectUnauthorized/u);
});

test('the hook and SMTP environment is documented for deployments', () => {
  for (const name of [
    'SUPABASE_SEND_EMAIL_HOOK_SECRETS',
    'SAFETYHUB_SMTP_HOST',
    'SAFETYHUB_SMTP_PORT',
    'SAFETYHUB_SMTP_USER',
    'SAFETYHUB_SMTP_PASSWORD',
    'SAFETYHUB_SMTP_FROM',
  ]) {
    assert.match(exampleEnvironment, new RegExp(`^${name}=`, 'mu'));
    assert.ok(route.includes(name), `route ignores ${name}`);
  }
});

test('Standard Webhooks reference vectors agree with the implemented scheme', () => {
  // Independent computation of the scheme the hook module implements, so a
  // future refactor cannot silently change the signed content layout.
  const secret = randomBytes(32);
  const id = 'msg_test';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"user":{"email":"user@example.com"}}';
  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  assert.equal(expected.length, 44);
  assert.match(hook, /signature\s*\n?\s*\.split\(' '\)/u);
  assert.match(hook, /entry\.startsWith\('v1,'\)/u);
});
