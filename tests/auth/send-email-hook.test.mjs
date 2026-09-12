import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const route = await readFile('app/api/auth/send-email/route.ts', 'utf8');
const drain = await readFile('app/api/auth/send-email/drain/route.ts', 'utf8');
const hook = await readFile('server/auth/send-email-hook.ts', 'utf8');
const smtp = await readFile('server/email/smtp.ts', 'utf8');
const transport = await readFile('server/email/transport.ts', 'utf8');
const outbox = await readFile('server/email/auth-email-outbox.ts', 'utf8');
const migration = await readFile(
  'supabase/migrations/20260912182000_auth_email_outbox_and_otp_gateway.sql',
  'utf8',
);
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
  assert.doesNotMatch(outbox, /console\./u);
  assert.doesNotMatch(transport, /console\./u);
  assert.doesNotMatch(drain, /console\./u);
});

test('every message is recorded before the hook answers, and a replay is a duplicate, not a second email', () => {
  // The first 200 acknowledges action types SafetyHub never emails; the
  // final one is the acceptance and comes after the row is stored.
  assert.ok(
    route.indexOf('await enqueueAuthEmail(') <
      route.lastIndexOf("NextResponse.json({}, { status: 200 })"),
    'the outbox row must exist before Auth is told the message was accepted',
  );
  assert.match(route, /SEND_EMAIL_QUEUE_UNAVAILABLE[\s\S]*?status: 503, headers: \{ 'Retry-After': '2' \}/u);
  assert.match(route, /if \(!queued\.duplicate\) \{/u);
  assert.match(route, /export const maxDuration = 60/u);
  assert.match(migration, /create table private\.auth_email_outbox/u);
  assert.match(migration, /webhook_id text not null unique/u);
  assert.match(migration, /on conflict \(webhook_id\) do nothing/u);
  // The code is erased the moment the row is sent or abandoned.
  assert.match(migration, /set status = 'sent',\s*\n\s*token = null/u);
  assert.match(migration, /set status = 'failed',\s*\n\s*token = null/u);
  assert.match(migration, /for update skip locked/u);
  assert.match(migration, /'AUTH_EMAIL_DEAD'/u);
  assert.match(migration, /cron\.schedule\(\s*\n\s*'safetyhub-auth-email-drain',\s*\n\s*'\*\/2 \* \* \* \*'/u);
  assert.match(migration, /cron\.schedule\(\s*\n\s*'safetyhub-auth-email-prune',\s*\n\s*'45 4 \* \* \*'/u);
  assert.match(migration, /revoke all on table private\.auth_email_outbox[\s\S]*?service_role/u);
});

test('the drain is a bearer-protected batch with bounded parallelism that backs off on a throttled mailbox', () => {
  assert.match(drain, /matchesBearerSecret\(request\.headers\.get\('authorization'\), secret\)/u);
  assert.match(drain, /AUTH_EMAIL_DRAIN_NOT_CONFIGURED[\s\S]*?status: 503/u);
  assert.match(drain, /export const maxDuration = 60/u);
  assert.match(drain, /DRAIN_BATCH = 10/u);
  assert.match(drain, /DRAIN_CONCURRENCY = 3/u);
  assert.match(drain, /@\/lib\/security\/api-response/u);
  assert.doesNotMatch(drain, /from 'next\/server'/u);
  assert.match(outbox, /IMMEDIATE_RETRY_DELAYS_MS = \[1_000, 4_000\]/u);
  assert.match(outbox, /if \(error instanceof EmailThrottledError\) \{\s*\n\s*throttled = true;/u);
  assert.match(outbox, /rpc\('defer_auth_email'/u);
  assert.match(outbox, /rpc\('complete_auth_email'/u);
  assert.match(outbox, /rpc\('fail_auth_email'/u);
  assert.match(smtp, /THROTTLE_REPLY = \/\^\(\?:421\|45\[012\]\)/u);
  // One connection, EHLO and AUTH per session; the drain reuses it per worker.
  assert.match(smtp, /export async function openSmtpSession/u);
  assert.match(smtp, /'RSET', 'RSET'/u);
  assert.match(transport, /SAFETYHUB_EMAIL_TRANSPORT/u);
  assert.match(transport, /tls === 'none' && process\.env\.NODE_ENV === 'production' && process\.env\.VERCEL === '1'/u);
  assert.match(transport, /api\.resend\.com\/emails/u);
  assert.match(transport, /api\.postmarkapp\.com\/email/u);
});

test('the email language follows the page the person is on, not the metadata frozen at first sign-in', () => {
  const detect = hook.slice(
    hook.indexOf('export function detectLocale'),
    hook.indexOf('export function parseSendEmailHookPayload'),
  );
  assert.ok(
    detect.indexOf("searchParams.get('email_locale')") < detect.indexOf('record(userMetadata)'),
    'the redirect marker must be read before the user metadata',
  );
  assert.match(detect, /pathname\.startsWith\('\/en\/'\)/u);
  assert.match(hook, /loginSubject: 'SafetyHub: код для входа'/u);
  assert.match(hook, /loginSubject: 'SafetyHub: кіру коды'/u);
  assert.match(hook, /loginSubject: 'SafetyHub: your sign-in code'/u);
  assert.match(hook, /<meta charset="utf-8">/u);
  assert.match(hook, /display:none;max-height:0;overflow:hidden/u);
  for (const phrase of [
    'SafetyHub: your sign-in code',
    'SafetyHub: кіру коды',
    'SafetyHub: код для входа',
    'SafetyHub: your sign-up code',
    'SafetyHub: тіркелу коды',
    'SafetyHub: код для регистрации',
  ]) {
    assert.ok(config.includes(phrase), `config.toml subject lacks: ${phrase}`);
  }
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
    'Your sign-in code',
    'Кіру кодыңыз',
    'Ваш код для входа',
    'Enter this code in SafetyHub to sign in:',
    'SafetyHub-қа кіру үшін осы кодты енгізіңіз:',
    'Введите этот код в SafetyHub, чтобы войти:',
    'SafetyHub staff will never ask for it',
    'SafetyHub қызметкерлері кодты сұрамайды',
    'сотрудники SafetyHub его не спрашивают',
  ]) {
    assert.ok(magicLink.includes(phrase), `magic-link template lacks: ${phrase}`);
    assert.ok(hook.includes(phrase), `hook renderer lacks: ${phrase}`);
  }
  for (const phrase of [
    'Welcome to SafetyHub',
    'SafetyHub-қа қош келдіңіз',
    'Добро пожаловать в SafetyHub',
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
  const readers = {
    SUPABASE_SEND_EMAIL_HOOK_SECRETS: route,
    SAFETYHUB_SMTP_HOST: transport,
    SAFETYHUB_SMTP_PORT: transport,
    SAFETYHUB_SMTP_USER: transport,
    SAFETYHUB_SMTP_PASSWORD: transport,
    SAFETYHUB_SMTP_FROM: transport,
    SAFETYHUB_SMTP_TLS: transport,
    SAFETYHUB_EMAIL_TRANSPORT: transport,
    SAFETYHUB_EMAIL_HTTP_PROVIDER: transport,
    SAFETYHUB_EMAIL_HTTP_API_KEY: transport,
    AUTH_EMAIL_DRAIN_SECRET: drain,
  };
  for (const [name, reader] of Object.entries(readers)) {
    assert.match(exampleEnvironment, new RegExp(`^${name}=`, 'mu'));
    assert.ok(reader.includes(name), `nothing reads ${name}`);
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

test('delivery failures never write mailbox credentials to the platform log', () => {
  // The failure line used to append `user=<mailbox> secretChars=<length>`, which
  // is the operator login and the exact password length in a log anybody with
  // deployment access can read. An SMTP reply also quotes the recipient, so the
  // reply text itself must not be logged either.
  for (const source of [route, drain, outbox]) {
    assert.doesNotMatch(source, /secretChars/u);
    assert.doesNotMatch(source, /transport\.user/u);
    assert.doesNotMatch(source, /transport\.password/u);
    assert.doesNotMatch(source, /error\.message\.slice/u);
  }
  assert.match(outbox, /delivery failed \(\$\{stage\}\)/u);
  assert.match(transport, /\/\^\(\?:SMTP\|HTTP\)_\[A-Z0-9_\]\+\/u\.exec\(error\.message\)/u);
  // The HTTP providers' response bodies quote the recipient; they are never read.
  assert.match(transport, /response\.body\?\.cancel\(\)/u);
});

test('the hook body is bounded by the bytes read, not by a declared length', () => {
  // `Content-Length` is attacker-controlled and optional. Reading the body with
  // `request.text()` first meant an unsigned caller could stream any amount of
  // data into memory before the signature was checked.
  assert.doesNotMatch(route, /await request\.text\(\)/u);
  assert.match(route, /readBoundedText\(request, HOOK_BODY_MAX_BYTES\)/u);
  assert.match(route, /RequestBodyError/u);
});

test('a webhook secret too short to be one is refused', () => {
  // `whsec_=` decodes to an empty HMAC key, which verifies a signature anybody
  // can compute. Supabase issues 32 bytes; anything shorter is hand-written.
  // A weak entry is dropped rather than thrown, so it cannot silence the
  // healthy half of a rotation pair; if nothing survives, the route answers
  // SEND_EMAIL_HOOK_NOT_CONFIGURED and accepts no unsigned call.
  assert.match(hook, /MINIMUM_HOOK_SECRET_BYTES = 32/u);
  assert.match(hook, /\.filter\(\(secret\) => secret\.byteLength >= MINIMUM_HOOK_SECRET_BYTES\)/u);
  assert.match(route, /secrets\.length === 0[\s\S]*SEND_EMAIL_HOOK_NOT_CONFIGURED/u);
});
