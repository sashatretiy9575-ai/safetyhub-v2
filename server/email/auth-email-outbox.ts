import 'server-only';

import { randomUUID } from 'node:crypto';
import { renderAuthEmail, type AuthEmailLocale } from '@/server/auth/send-email-hook';
import {
  deliveryFailureStage,
  EmailThrottledError,
  openEmailSession,
  type EmailSession,
  type EmailTransport,
} from '@/server/email/transport';
import { createAdminClient } from '@/server/supabase/admin';

export type AuthEmailKind = 'signup' | 'magiclink' | 'recovery' | 'invite';

export type ClaimedAuthEmail = Readonly<{
  id: string;
  recipient: string;
  locale: AuthEmailLocale;
  kind: AuthEmailKind;
  token: string | null;
  attempts: number;
  leaseToken: string;
}>;

export type DeliverySummary = Readonly<{
  claimed: number;
  sent: number;
  deferred: number;
  failed: number;
}>;

// Two quick retries inside the same invocation cover a dropped connection;
// anything longer is the drain's job, so the function is not kept alive.
const IMMEDIATE_RETRY_DELAYS_MS = [1_000, 4_000] as const;
const RETRY_BACKOFF_SECONDS = [120, 300, 600, 1200, 1800] as const;
const THROTTLE_DEFER_SECONDS = 600;
const LEASE_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type OutboxRpcClient = {
  rpc(
    name:
      | 'enqueue_auth_email'
      | 'claim_auth_email_outbox'
      | 'complete_auth_email'
      | 'fail_auth_email'
      | 'defer_auth_email',
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function client() {
  return createAdminClient() as unknown as OutboxRpcClient;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function enqueueAuthEmail(
  input: Readonly<{
    webhookId: string;
    recipient: string;
    locale: AuthEmailLocale;
    kind: AuthEmailKind;
    token: string;
  }>,
): Promise<Readonly<{ id: string; duplicate: boolean }>> {
  const { data, error } = await client().rpc('enqueue_auth_email', {
    p_webhook_id: input.webhookId,
    p_recipient: input.recipient,
    p_locale: input.locale,
    p_kind: input.kind,
    p_token: input.token,
  });
  const payload = record(data);
  if (error || typeof payload?.id !== 'string' || !UUID.test(payload.id)) {
    throw new Error('AUTH_EMAIL_ENQUEUE_FAILED');
  }
  return { id: payload.id, duplicate: payload.duplicate === true };
}

function parseClaimed(value: unknown): ClaimedAuthEmail[] {
  if (!Array.isArray(value)) return [];
  const rows: ClaimedAuthEmail[] = [];
  for (const entry of value) {
    const row = record(entry);
    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.recipient !== 'string' ||
      typeof row.leaseToken !== 'string' ||
      (row.locale !== 'ru' && row.locale !== 'kk' && row.locale !== 'en') ||
      (row.kind !== 'signup' &&
        row.kind !== 'magiclink' &&
        row.kind !== 'recovery' &&
        row.kind !== 'invite')
    ) {
      continue;
    }
    rows.push({
      id: row.id,
      recipient: row.recipient,
      locale: row.locale,
      kind: row.kind,
      token: typeof row.token === 'string' ? row.token : null,
      attempts: Math.max(1, Math.floor(Number(row.attempts) || 1)),
      leaseToken: row.leaseToken,
    });
  }
  return rows;
}

export async function claimAuthEmails(
  options: Readonly<{ limit: number; onlyId?: string }> = { limit: 10 },
): Promise<ClaimedAuthEmail[]> {
  const { data, error } = await client().rpc('claim_auth_email_outbox', {
    p_worker_id: randomUUID(),
    p_limit: Math.min(50, Math.max(1, options.limit)),
    p_lease_seconds: LEASE_SECONDS,
    p_only_id: options.onlyId ?? null,
  });
  if (error) throw new Error('AUTH_EMAIL_CLAIM_FAILED');
  return parseClaimed(data);
}

async function completeAuthEmail(row: ClaimedAuthEmail) {
  const { error } = await client().rpc('complete_auth_email', {
    p_id: row.id,
    p_lease_token: row.leaseToken,
  });
  if (error) throw new Error('AUTH_EMAIL_COMPLETE_FAILED');
}

async function failAuthEmail(row: ClaimedAuthEmail, stage: string) {
  const backoff =
    RETRY_BACKOFF_SECONDS[Math.min(row.attempts, RETRY_BACKOFF_SECONDS.length) - 1] ?? 120;
  const { error } = await client().rpc('fail_auth_email', {
    p_id: row.id,
    p_lease_token: row.leaseToken,
    p_error: stage,
    p_retry_after_seconds: backoff,
  });
  if (error) throw new Error('AUTH_EMAIL_FAIL_FAILED');
}

async function deferAuthEmail(row: ClaimedAuthEmail) {
  const { error } = await client().rpc('defer_auth_email', {
    p_id: row.id,
    p_lease_token: row.leaseToken,
    p_retry_after_seconds: THROTTLE_DEFER_SECONDS,
  });
  if (error) throw new Error('AUTH_EMAIL_DEFER_FAILED');
}

function reportFailure(stage: string) {
  // The message holds a one-time code, and an SMTP reply line quotes the
  // recipient. Only the failing stage reaches the Vercel log: enough to tell
  // an outage from a rejected login, and it carries neither the mailbox
  // address, nor the operator login, nor the password length.
  process.stderr.write(`auth email delivery failed (${stage})\n`);
}

async function sendWithRetries(session: EmailSession, row: ClaimedAuthEmail) {
  const email = renderAuthEmail({
    actionType: row.kind,
    token: row.token ?? '',
    locale: row.locale,
  });
  if (!email) throw new Error('AUTH_EMAIL_KIND_UNSUPPORTED');
  const message = { to: row.recipient, subject: email.subject, html: email.html };
  let lastError: unknown;
  for (let attempt = 0; attempt <= IMMEDIATE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await session.send(message);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof EmailThrottledError) throw error;
      const delay = IMMEDIATE_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Delivers claimed rows with a bounded number of parallel provider sessions.
 * A throttled reply stops the whole run: the remaining rows are deferred for
 * later without spending their attempts, so a mailbox at its hourly ceiling
 * is not hammered ten times in a row.
 */
export async function deliverClaimedAuthEmails(
  rows: readonly ClaimedAuthEmail[],
  transport: EmailTransport,
  concurrency = 3,
): Promise<DeliverySummary> {
  const summary = { claimed: rows.length, sent: 0, deferred: 0, failed: 0 };
  if (rows.length === 0) return summary;
  const queue = [...rows];
  let throttled = false;

  const worker = async () => {
    let session: EmailSession | null = null;
    try {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) break;
        if (throttled) {
          await deferAuthEmail(row);
          summary.deferred += 1;
          continue;
        }
        try {
          session ??= await openEmailSession(transport);
          await sendWithRetries(session, row);
          await completeAuthEmail(row);
          summary.sent += 1;
        } catch (error) {
          const stage = deliveryFailureStage(error);
          reportFailure(stage);
          if (error instanceof EmailThrottledError) {
            throttled = true;
            await deferAuthEmail(row);
            summary.deferred += 1;
            continue;
          }
          // A broken connection is replaced for the next row.
          session?.close();
          session = null;
          await failAuthEmail(row, stage);
          summary.failed += 1;
        }
      }
    } finally {
      session?.close();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return summary;
}

/** Hook path: the row was just enqueued and is delivered right away, once. */
export async function deliverAuthEmailNow(id: string, transport: EmailTransport) {
  try {
    const rows = await claimAuthEmails({ limit: 1, onlyId: id });
    if (rows.length === 0) return;
    await deliverClaimedAuthEmails(rows, transport, 1);
  } catch (error) {
    // The drain retries anything still queued; the lease expires on its own.
    reportFailure(deliveryFailureStage(error));
  }
}
