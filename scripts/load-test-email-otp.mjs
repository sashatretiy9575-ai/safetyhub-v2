// "A hundred people press Sign in at once" against a local stand.
//
// Fires N parallel POST /api/auth/email-otp/request calls at a locally running
// app (dev or start) that talks to the disposable local Supabase, then asks the
// drain to deliver whatever the hook could not, and finally counts the messages
// in Mailpit. It refuses every other target: the addresses are throwaway, and
// the Turnstile token is Cloudflare's public dummy that only the local Auth
// container accepts.
//
// Usage: node --env-file-if-exists=.env.local scripts/load-test-email-otp.mjs
//   SAFETYHUB_OTP_LOAD_REQUESTS=100      how many people press the button
//   SAFETYHUB_OTP_LOAD_APP_URL=http://localhost:3000   (defaults to NEXT_PUBLIC_SITE_URL)
//   SAFETYHUB_OTP_LOAD_DRAIN=1           call the drain with AUTH_EMAIL_DRAIN_SECRET afterwards
import { setDefaultResultOrder } from 'node:dns';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { Client as PostgresClient } from 'pg';
import { LOCAL_CI_DATABASE_URL, LOCAL_CI_SUPABASE_URL } from './load-test-safety.mjs';

// `localhost` resolves to ::1 first on Windows while the dev server listens on IPv4.
setDefaultResultOrder('ipv4first');

const LOCAL_TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const MAILPIT_URL = 'http://127.0.0.1:54324';
const LOCALES = ['ru', 'kk', 'en'];

function refuse(message) {
  throw new Error(`Refusing OTP load test: ${message}`);
}

function positiveInteger(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function percentile(values, share) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(share * ordered.length) - 1));
  return Number(ordered[index].toFixed(1));
}

function assertLocalTarget() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (supabaseUrl !== LOCAL_CI_SUPABASE_URL) {
    refuse(`NEXT_PUBLIC_SUPABASE_URL must be exactly ${LOCAL_CI_SUPABASE_URL}`);
  }
  // The request route is origin-bound, so the calls carry the site origin the
  // app itself is configured with.
  const appUrl = new URL(
    process.env.SAFETYHUB_OTP_LOAD_APP_URL ??
      process.env.NEXT_PUBLIC_SITE_URL ??
      'http://localhost:3000',
  );
  if (appUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(appUrl.hostname)) {
    refuse('the application under test must be a loopback http origin');
  }
  return { appUrl: appUrl.origin, databaseUrl: LOCAL_CI_DATABASE_URL };
}

async function requestCode(appUrl, index, locale) {
  const email = `otp-load-${Date.now().toString(36)}-${index}@example.test`;
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${appUrl}/api/auth/email-otp/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: appUrl,
        'x-forwarded-for': `10.${(index >> 8) & 255}.${index & 255}.7`,
      },
      body: JSON.stringify({ email, captchaToken: LOCAL_TURNSTILE_DUMMY_TOKEN, locale }),
    });
  } catch {
    return { email, locale, status: 0, error: 'NETWORK', ms: performance.now() - started };
  }
  const payload = await response.json().catch(() => null);
  return {
    email,
    locale,
    status: response.status,
    error: typeof payload?.error === 'string' ? payload.error : null,
    retryAfter: Number(payload?.retryAfter) || Number(response.headers.get('retry-after')) || null,
    ms: performance.now() - started,
  };
}

async function outboxSummary(databaseUrl, emails) {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select status, count(*)::int as count,
              count(*) filter (where token is null)::int as without_token
       from private.auth_email_outbox
       where recipient = any($1::text[])
       group by status order by status`,
      [emails],
    );
    return rows;
  } finally {
    await client.end();
  }
}

async function drain(appUrl) {
  const secret = process.env.AUTH_EMAIL_DRAIN_SECRET?.trim();
  if (!secret) return { skipped: 'AUTH_EMAIL_DRAIN_SECRET is not set' };
  const rounds = [];
  for (let round = 0; round < 12; round += 1) {
    let response;
    try {
      response = await fetch(`${appUrl}/api/auth/send-email/drain`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      rounds.push({ status: 0, error: 'NETWORK' });
      break;
    }
    const summary = await response.json().catch(() => null);
    rounds.push({ status: response.status, ...(summary ?? {}) });
    if (!response.ok || !summary || summary.claimed === 0) break;
  }
  return { rounds };
}

async function countMailpit(emails) {
  const wanted = new Set(emails);
  const seen = new Map();
  let start = 0;
  for (;;) {
    let response;
    try {
      response = await fetch(`${MAILPIT_URL}/api/v1/messages?start=${start}&limit=200`);
    } catch {
      return { error: 'Mailpit is not reachable' };
    }
    if (!response.ok) return { error: `Mailpit answered ${response.status}` };
    const page = await response.json();
    for (const message of page.messages ?? []) {
      for (const recipient of message.To ?? []) {
        const address = String(recipient.Address ?? '').toLowerCase();
        if (wanted.has(address)) seen.set(address, (seen.get(address) ?? 0) + 1);
      }
    }
    start += page.messages?.length ?? 0;
    if (!page.messages?.length || start >= (page.total ?? 0)) break;
  }
  const duplicates = [...seen.values()].filter((count) => count > 1).length;
  return { delivered: seen.size, duplicates };
}

async function main() {
  const { appUrl, databaseUrl } = assertLocalTarget();
  const total = positiveInteger('SAFETYHUB_OTP_LOAD_REQUESTS', 100, 500);
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: total }, (_, index) => requestCode(appUrl, index, LOCALES[index % 3])),
  );
  const wallMs = performance.now() - started;
  const byStatus = {};
  const byError = {};
  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    if (result.error) byError[result.error] = (byError[result.error] ?? 0) + 1;
  }
  const serverErrors = results.filter((result) => result.status === 0 || result.status >= 500);
  const refusalsWithoutRetry = results.filter(
    (result) => result.status === 429 && !(result.retryAfter > 0),
  );
  const accepted = results.filter((result) => result.status === 202);
  const emails = results.map((result) => result.email);

  // Give the after-response deliveries a moment before looking at the queue.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const beforeDrain = await outboxSummary(databaseUrl, emails);
  const drained = process.env.SAFETYHUB_OTP_LOAD_DRAIN === '1' ? await drain(appUrl) : null;
  const afterDrain = await outboxSummary(databaseUrl, emails);
  const mailpit = await countMailpit(accepted.map((result) => result.email));

  const report = {
    target: appUrl,
    requests: total,
    wallSeconds: Number((wallMs / 1000).toFixed(2)),
    latencyMs: {
      p50: percentile(results.map((result) => result.ms), 0.5),
      p95: percentile(results.map((result) => result.ms), 0.95),
      max: percentile(results.map((result) => result.ms), 1),
    },
    byStatus,
    byError,
    accepted: accepted.length,
    serverErrors: serverErrors.length,
    refusalsWithoutRetryAfter: refusalsWithoutRetry.length,
    outboxBeforeDrain: beforeDrain,
    drain: drained,
    outboxAfterDrain: afterDrain,
    mailpit,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const failures = [];
  if (serverErrors.length > 0) failures.push(`${serverErrors.length} responses were 5xx or dropped`);
  if (refusalsWithoutRetry.length > 0) failures.push('a 429 came without a positive retryAfter');
  const queuedRows = afterDrain.reduce((sum, row) => sum + row.count, 0);
  if (queuedRows !== accepted.length) {
    failures.push(`outbox holds ${queuedRows} rows for ${accepted.length} accepted requests`);
  }
  const sentRows = afterDrain.find((row) => row.status === 'sent');
  if (sentRows && sentRows.without_token !== sentRows.count) {
    failures.push('a sent row still carries its code');
  }
  if (mailpit.error) failures.push(mailpit.error);
  else if (mailpit.duplicates > 0) failures.push(`${mailpit.duplicates} addresses got two emails`);
  if (failures.length > 0) {
    process.stderr.write(`OTP load test failed: ${failures.join('; ')}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
