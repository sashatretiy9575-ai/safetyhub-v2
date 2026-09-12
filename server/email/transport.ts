import 'server-only';

import {
  openSmtpSession,
  SmtpError,
  type SmtpMessage,
  type SmtpTransport,
} from '@/server/email/smtp';

export type EmailMessage = Readonly<{ to: string; subject: string; html: string }>;

export type EmailTransport =
  | Readonly<{ kind: 'smtp'; from: string; smtp: SmtpTransport }>
  | Readonly<{
      kind: 'http';
      from: string;
      provider: 'resend' | 'postmark';
      apiKey: string;
      timeoutMs: number;
    }>;

export type EmailSession = Readonly<{
  send(message: EmailMessage): Promise<void>;
  close(): void;
}>;

/** A provider refusal that says "later", not "never": the message is deferred, not failed. */
export class EmailThrottledError extends Error {
  constructor(readonly stage: string) {
    super(`EMAIL_THROTTLED: ${stage}`);
    this.name = 'EmailThrottledError';
  }
}

const HTTP_TIMEOUT_MS = 15_000;
const HTTP_ENDPOINTS = {
  resend: 'https://api.resend.com/emails',
  postmark: 'https://api.postmarkapp.com/email',
} as const;

function trimmed(name: string) {
  return process.env[name]?.trim() || '';
}

/**
 * Reads the delivery configuration once per request. `SAFETYHUB_EMAIL_TRANSPORT`
 * is `smtp` (the PS.kz mailbox, or any provider's SMTP relay on port 465) or
 * `http` (Resend or Postmark through their JSON APIs, no SDK). Switching
 * providers is a change of environment variables, not of code.
 */
export function resolveEmailTransport(): EmailTransport | null {
  const from = trimmed('SAFETYHUB_SMTP_FROM') || trimmed('SAFETYHUB_SMTP_USER');
  if (!from || !from.includes('@')) return null;
  const kind = trimmed('SAFETYHUB_EMAIL_TRANSPORT') || 'smtp';

  if (kind === 'http') {
    const provider = trimmed('SAFETYHUB_EMAIL_HTTP_PROVIDER');
    const apiKey = trimmed('SAFETYHUB_EMAIL_HTTP_API_KEY');
    if ((provider !== 'resend' && provider !== 'postmark') || apiKey.length < 16) return null;
    return { kind: 'http', from, provider, apiKey, timeoutMs: HTTP_TIMEOUT_MS };
  }
  if (kind !== 'smtp') return null;

  const host = trimmed('SAFETYHUB_SMTP_HOST');
  const user = trimmed('SAFETYHUB_SMTP_USER');
  const password = trimmed('SAFETYHUB_SMTP_PASSWORD');
  const port = Number(process.env.SAFETYHUB_SMTP_PORT ?? '465');
  const tls = trimmed('SAFETYHUB_SMTP_TLS') || 'implicit';
  if (tls !== 'implicit' && tls !== 'none') return null;
  // Plain SMTP is for the local Mailpit only; a production deployment that
  // asks for it is misconfigured and must not send credentials in the clear.
  if (tls === 'none' && process.env.NODE_ENV === 'production' && process.env.VERCEL === '1') {
    return null;
  }
  if (!host || !user || !Number.isInteger(port) || port <= 0) return null;
  if (tls === 'implicit' && !password) return null;
  return { kind: 'smtp', from, smtp: { host, port, user, password, tls } };
}

function httpBody(
  transport: Extract<EmailTransport, { kind: 'http' }>,
  message: EmailMessage,
): Readonly<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> {
  if (transport.provider === 'resend') {
    return {
      url: HTTP_ENDPOINTS.resend,
      headers: { Authorization: `Bearer ${transport.apiKey}` },
      body: {
        from: `SafetyHub <${transport.from}>`,
        to: [message.to],
        subject: message.subject,
        html: message.html,
      },
    };
  }
  return {
    url: HTTP_ENDPOINTS.postmark,
    headers: { 'X-Postmark-Server-Token': transport.apiKey },
    body: {
      From: `SafetyHub <${transport.from}>`,
      To: message.to,
      Subject: message.subject,
      HtmlBody: message.html,
      MessageStream: 'outbound',
    },
  };
}

function httpSession(transport: Extract<EmailTransport, { kind: 'http' }>): EmailSession {
  return {
    async send(message) {
      const request = httpBody(transport, message);
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...request.headers },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(transport.timeoutMs),
        });
      } catch {
        throw new Error('HTTP_NETWORK');
      }
      // Nothing from the response body reaches a log: it may quote the recipient.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      if (response.status === 429 || response.status >= 500) {
        throw new EmailThrottledError(`HTTP_${response.status}`);
      }
      throw new Error(`HTTP_${response.status}`);
    },
    close() {},
  };
}

async function smtpSession(
  transport: Extract<EmailTransport, { kind: 'smtp' }>,
): Promise<EmailSession> {
  const session = await openSmtpSession(transport.smtp);
  return {
    async send(message) {
      const smtpMessage: SmtpMessage = { from: transport.from, ...message };
      try {
        await session.send(smtpMessage);
      } catch (error) {
        if (error instanceof SmtpError && error.throttled) {
          throw new EmailThrottledError(`SMTP_${error.stage}`);
        }
        throw error;
      }
    },
    close() {
      session.quit();
    },
  };
}

/** Opens a session that can carry several messages; SMTP authenticates once. */
export function openEmailSession(transport: EmailTransport): Promise<EmailSession> {
  return transport.kind === 'http'
    ? Promise.resolve(httpSession(transport))
    : smtpSession(transport);
}

/**
 * Failure stage safe for a platform log: the transport's own code (an SMTP
 * stage, an HTTP status) and never the reply text, which quotes the recipient.
 */
export function deliveryFailureStage(error: unknown) {
  if (error instanceof EmailThrottledError) return error.stage.slice(0, 64);
  if (error instanceof Error) {
    return /^(?:SMTP|HTTP)_[A-Z0-9_]+/u.exec(error.message)?.[0]?.slice(0, 64) ?? 'SEND_FAILED';
  }
  return 'SEND_UNKNOWN';
}
