import 'server-only';

import { connect as connectTls, type TLSSocket } from 'node:tls';

export type SmtpMessage = Readonly<{
  from: string;
  to: string;
  subject: string;
  html: string;
}>;

export type SmtpTransport = Readonly<{
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 20_000;
const SENDER_NAME = 'SafetyHub';

export class SmtpError extends Error {
  readonly stage: string;
  readonly reply: string;

  constructor(stage: string, reply: string) {
    super(`SMTP_${stage}: ${reply.slice(0, 160)}`);
    this.name = 'SmtpError';
    this.stage = stage;
    this.reply = reply;
  }
}

function encodeHeaderWord(value: string) {
  // RFC 2047 encoded-word keeps Cyrillic and Kazakh subjects intact.
  return /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(value: string) {
  return (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/gu) ?? []).join('\r\n');
}

function assertAddress(value: string, label: string) {
  if (!/^[^\s<>@,;"]+@[^\s<>@,;"]+$/u.test(value)) throw new Error(`${label}_INVALID`);
}

export function buildMimeMessage(message: SmtpMessage) {
  assertAddress(message.from, 'SMTP_FROM');
  assertAddress(message.to, 'SMTP_TO');
  const messageId = `<${crypto.randomUUID()}@${message.from.split('@')[1]}>`;
  return [
    `From: ${encodeHeaderWord(SENDER_NAME)} <${message.from}>`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeaderWord(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    base64Lines(message.html),
    '',
  ].join('\r\n');
}

class SmtpSession {
  private buffer = '';
  private readonly waiters: Array<(reply: string) => void> = [];
  private closed: Error | null = null;

  constructor(private readonly socket: TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    const fail = (error: Error) => {
      this.closed = error;
      for (const waiter of this.waiters.splice(0)) waiter('');
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('SMTP_CONNECTION_CLOSED')));
  }

  private flush() {
    // A reply is complete once a line has a space (not a dash) after the code.
    const match = this.buffer.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/u);
    if (!match || this.waiters.length === 0) return;
    this.buffer = this.buffer.slice(match[0].length);
    this.waiters.shift()?.(match[0]);
    this.flush();
  }

  read(): Promise<string> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.waiters.push((reply) => (reply ? resolve(reply) : reject(this.closed)));
      this.flush();
    });
  }

  async command(stage: string, line: string, expected: RegExp) {
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expected.test(reply)) throw new SmtpError(stage, reply);
    return reply;
  }
}

async function authenticate(session: SmtpSession, transport: SmtpTransport, greeting: string) {
  const advertised = greeting.toUpperCase();
  // RFC 4616 PLAIN: authorization identity (empty), NUL, user, NUL, password.
  const plain = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(transport.user, 'utf8'),
    Buffer.from([0]),
    Buffer.from(transport.password, 'utf8'),
  ]).toString('base64');
  if (advertised.includes('PLAIN')) {
    return session.command('AUTH', `AUTH PLAIN ${plain}`, /^235/u);
  }
  // LOGIN is the fallback for servers that advertise no PLAIN mechanism.
  await session.command('AUTH', 'AUTH LOGIN', /^334/u);
  await session.command('AUTH', Buffer.from(transport.user, 'utf8').toString('base64'), /^334/u);
  return session.command(
    'AUTH',
    Buffer.from(transport.password, 'utf8').toString('base64'),
    /^235/u,
  );
}

/**
 * Minimal SMTP-over-implicit-TLS client (port 465) for transactional auth
 * mail. It deliberately supports only AUTH PLAIN/LOGIN over TLS and one
 * recipient.
 */
export async function sendSmtpMail(transport: SmtpTransport, message: SmtpMessage) {
  const timeoutMs = transport.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mime = buildMimeMessage(message);

  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = connectTls(
      { host: transport.host, port: transport.port, servername: transport.host },
      () => resolve(tlsSocket),
    );
    tlsSocket.once('error', reject);
    tlsSocket.setTimeout(timeoutMs, () => {
      tlsSocket.destroy(new Error('SMTP_TIMEOUT'));
    });
  });

  try {
    const session = new SmtpSession(socket);
    const greeting = await session.read();
    if (!greeting.startsWith('220')) throw new SmtpError('GREETING', greeting);
    const capabilities = await session.command(
      'EHLO',
      `EHLO ${message.from.split('@')[1]}`,
      /^250/u,
    );
    await authenticate(session, transport, capabilities);
    await session.command('MAIL', `MAIL FROM:<${message.from}>`, /^250/u);
    await session.command('RCPT', `RCPT TO:<${message.to}>`, /^25[01]/u);
    await session.command('DATA', 'DATA', /^354/u);
    // Dot-stuffing is unnecessary: the body is base64 and the headers are ours.
    const accepted = await session.command('BODY', `${mime}\r\n.`, /^250/u);
    socket.write('QUIT\r\n');
    return accepted.trim();
  } finally {
    socket.destroy();
  }
}
