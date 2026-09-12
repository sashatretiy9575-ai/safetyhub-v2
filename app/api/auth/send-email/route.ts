import { NextResponse } from '@/lib/security/api-response';
import {
  parseHookSecrets,
  parseSendEmailHookPayload,
  renderAuthEmail,
  verifyStandardWebhook,
} from '@/server/auth/send-email-hook';
import { deliverAuthEmailNow, enqueueAuthEmail } from '@/server/email/auth-email-outbox';
import { resolveEmailTransport, type EmailTransport } from '@/server/email/transport';
import { readBoundedText, RequestBodyError } from '@/lib/security/request-body';
import { afterResponse } from '@/server/http/after-response';

export const runtime = 'nodejs';
// The first delivery attempt runs after the response; a slow mailbox must
// not be cut off by the default function budget.
export const maxDuration = 60;

const HOOK_BODY_MAX_BYTES = 64 * 1024;
const WEBHOOK_ID_MAX_LENGTH = 200;

function hookSecrets() {
  try {
    return parseHookSecrets(process.env.SUPABASE_SEND_EMAIL_HOOK_SECRETS);
  } catch {
    return [];
  }
}

function deliver(id: string, transport: EmailTransport) {
  return deliverAuthEmailNow(id, transport);
}

/**
 * Supabase Auth "Send Email" hook. Auth waits only a few seconds for this
 * endpoint, so the message is recorded in the outbox, the hook answers 200,
 * and the hand-off to the mailbox provider runs after the response. A
 * message the mailbox refuses stays queued for the drain instead of being
 * lost behind a "code sent" screen; a replayed webhook id is a duplicate.
 */
export async function POST(request: Request) {
  const secrets = hookSecrets();
  const transport = resolveEmailTransport();
  if (secrets.length === 0 || !transport) {
    return NextResponse.json({ error: 'SEND_EMAIL_HOOK_NOT_CONFIGURED' }, { status: 500 });
  }

  // A missing, non-numeric or understated Content-Length used to let an
  // unsigned caller stream an unbounded body into memory before the signature
  // was ever checked. The cap now applies to the bytes actually read.
  let body: string;
  try {
    body = await readBoundedText(request, HOOK_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
  }

  const webhookId = request.headers.get('webhook-id');
  const verified = verifyStandardWebhook({
    secrets,
    id: webhookId,
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
    body,
  });
  if (!verified || !webhookId || webhookId.length > WEBHOOK_ID_MAX_LENGTH) {
    return NextResponse.json({ error: 'INVALID_SIGNATURE' }, { status: 401 });
  }

  let payload: ReturnType<typeof parseSendEmailHookPayload>;
  try {
    payload = parseSendEmailHookPayload(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  // Action types SafetyHub never emails are acknowledged and dropped.
  if (!renderAuthEmail(payload)) return NextResponse.json({}, { status: 200 });
  const kind = payload.actionType as 'signup' | 'magiclink' | 'recovery' | 'invite';

  let queued: Awaited<ReturnType<typeof enqueueAuthEmail>>;
  try {
    queued = await enqueueAuthEmail({
      webhookId,
      recipient: payload.email,
      locale: payload.locale,
      kind,
      token: payload.token,
    });
  } catch {
    // Auth retries 503 with the same webhook id; a 200 here would tell the
    // person the code was sent while nothing remembers it.
    return NextResponse.json(
      { error: 'SEND_EMAIL_QUEUE_UNAVAILABLE' },
      { status: 503, headers: { 'Retry-After': '2' } },
    );
  }
  if (!queued.duplicate) {
    const queuedId = queued.id;
    afterResponse(() => deliver(queuedId, transport));
  }
  return NextResponse.json({}, { status: 200 });
}
