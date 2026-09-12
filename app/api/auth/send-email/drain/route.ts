import { NextResponse } from '@/lib/security/api-response';
import { claimAuthEmails, deliverClaimedAuthEmails } from '@/server/email/auth-email-outbox';
import { resolveEmailTransport } from '@/server/email/transport';
import { matchesBearerSecret } from '@/server/security/bearer-secret';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Ten messages with three parallel mailbox sessions fit comfortably inside
// one invocation even when every message needs its two immediate retries.
const DRAIN_BATCH = 10;
const DRAIN_CONCURRENCY = 3;

/**
 * Retries sign-in emails the hook could not hand to the mailbox. pg_cron
 * calls it every two minutes while something is due, through the secret
 * stored in Vault by `npm run auth:email-drain:vault:configure`. Without the
 * secret the endpoint is closed and the hook keeps delivering on its own.
 */
export async function POST(request: Request) {
  const secret = process.env.AUTH_EMAIL_DRAIN_SECRET;
  if (!secret?.trim()) {
    return NextResponse.json({ error: 'AUTH_EMAIL_DRAIN_NOT_CONFIGURED' }, { status: 503 });
  }
  if (!matchesBearerSecret(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const transport = resolveEmailTransport();
  if (!transport) {
    return NextResponse.json({ error: 'SEND_EMAIL_HOOK_NOT_CONFIGURED' }, { status: 503 });
  }

  let rows: Awaited<ReturnType<typeof claimAuthEmails>>;
  try {
    rows = await claimAuthEmails({ limit: DRAIN_BATCH });
  } catch {
    return NextResponse.json({ error: 'AUTH_EMAIL_QUEUE_UNAVAILABLE' }, { status: 503 });
  }
  const summary = await deliverClaimedAuthEmails(rows, transport, DRAIN_CONCURRENCY);
  return NextResponse.json(summary);
}
