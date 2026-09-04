import { NextResponse } from '@/lib/security/api-response';
import {
  parseHookSecrets,
  parseSendEmailHookPayload,
  renderAuthEmail,
  verifyStandardWebhook,
} from '@/features/auth/send-email-hook';
import { sendSmtpMail } from '@/lib/email/smtp';
import { afterResponse } from '@/lib/server/after-response';

export const runtime = 'nodejs';

const HOOK_BODY_MAX_BYTES = 64 * 1024;
const SEND_ATTEMPTS = 2;

type Transport = Readonly<{
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}>;

function smtpTransport(): Transport | null {
  const host = process.env.SAFETYHUB_SMTP_HOST?.trim();
  const user = process.env.SAFETYHUB_SMTP_USER?.trim();
  const password = process.env.SAFETYHUB_SMTP_PASSWORD;
  const from = process.env.SAFETYHUB_SMTP_FROM?.trim() || user;
  const port = Number(process.env.SAFETYHUB_SMTP_PORT ?? '465');
  if (!host || !user || !password || !from || !Number.isInteger(port) || port <= 0) {
    return null;
  }
  return { host, port, user, password, from };
}

function hookSecrets() {
  try {
    return parseHookSecrets(process.env.SUPABASE_SEND_EMAIL_HOOK_SECRETS);
  } catch {
    return [];
  }
}

async function deliver(transport: Transport, to: string, subject: string, html: string) {
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      await sendSmtpMail(transport, { from: transport.from, to, subject, html });
      return;
    } catch (error) {
      // The message holds a one-time code, so only the failure class reaches
      // the Vercel log; that is still enough to spot an SMTP outage.
      if (attempt === SEND_ATTEMPTS) {
        const reason = error instanceof Error ? error.message.split(':')[0] : 'SMTP_UNKNOWN';
        process.stderr.write(`auth send-email hook: delivery failed (${reason})\n`);
      }
    }
  }
}

/**
 * Supabase Auth "Send Email" hook. Auth waits only a few seconds for this
 * endpoint, so the SMTP hand-off to the mailbox provider runs after the 200
 * response instead of inside the user's OTP request.
 */
export async function POST(request: Request) {
  const secrets = hookSecrets();
  const transport = smtpTransport();
  if (secrets.length === 0 || !transport) {
    return NextResponse.json({ error: 'SEND_EMAIL_HOOK_NOT_CONFIGURED' }, { status: 500 });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > HOOK_BODY_MAX_BYTES) {
    return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > HOOK_BODY_MAX_BYTES) {
    return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
  }

  const verified = verifyStandardWebhook({
    secrets,
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
    body,
  });
  if (!verified) {
    return NextResponse.json({ error: 'INVALID_SIGNATURE' }, { status: 401 });
  }

  let payload: ReturnType<typeof parseSendEmailHookPayload>;
  try {
    payload = parseSendEmailHookPayload(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const email = renderAuthEmail(payload);
  if (email) {
    afterResponse(() => deliver(transport, payload.email, email.subject, email.html));
  }
  return NextResponse.json({}, { status: 200 });
}
