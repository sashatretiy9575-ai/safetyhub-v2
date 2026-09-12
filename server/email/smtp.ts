import 'server-only';

import { connect as connectTcp, type Socket } from 'node:net';
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
  /** `implicit` is TLS on connect (port 465); `none` is plain TCP for a local Mailpit. */
  tls?: 'implicit' | 'none';
  timeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 20_000;
const SENDER_NAME = 'SafetyHub';
// 421 closes the connection, 450/451/452 are temporary mailbox refusals; the
// wording covers providers that answer 550 with a rate-limit text instead.
const THROTTLE_REPLY = /^(?:421|45[012])|rate ?limit|too many|quota|throttl|try (?:again )?later/iu;

export class SmtpError extends Error {
  readonly stage: string;
  readonly reply: string;
  /** The mailbox asked to slow down: retry later without spending an attempt. */
  readonly throttled: boolean;

  constructor(stage: string, reply: string) {
    super(`SMTP_${stage}: ${reply.slice(0, 160)}`);
    this.name = 'SmtpError';
    this.stage = stage;
    this.reply = reply;
    this.throttled = THROTTLE_REPLY.test(reply);
  }
}

function encodeHeaderWord(value: string) {
  // RFC 2047 encoded-word keeps Cyrillic and Kazakh subjects intact.
  return /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(value: string) {
  return (
    Buffer.from(value, 'utf8')
      .toString('base64')
      .match(/.{1,76}/gu) ?? []
  ).join('\r\n');
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

class SmtpConnection {
  private buffer = '';
  private readonly waiters: Array<(reply: string) => void> = [];
  private closed: Error | null = null;

  constructor(private readonly socket: Socket | TLSSocket) {
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

  get alive() {
    return this.closed === null;
  }

  destroy() {
    this.socket.destroy();
  }

  quit() {
    if (this.closed) return;
    this.socket.write('QUIT\r\n');
    this.socket.end();
  }
}

async function authenticate(
  connection: SmtpConnection,
  transport: SmtpTransport,
  greeting: string,
) {
  const advertised = greeting.toUpperCase();
  // A relay without AUTH (the local Mailpit) is only acceptable without TLS,
  // which the transport resolver already restricts to non-production.
  if (!advertised.includes('AUTH') && transport.tls === 'none') return;
  // RFC 4616 PLAIN: authorization identity (empty), NUL, user, NUL, password.
  const plain = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(transport.user, 'utf8'),
    Buffer.from([0]),
    Buffer.from(transport.password, 'utf8'),
  ]).toString('base64');
  if (advertised.includes('PLAIN')) {
    await connection.command('AUTH', `AUTH PLAIN ${plain}`, /^235/u);
    return;
  }
  // LOGIN is the fallback for servers that advertise no PLAIN mechanism.
  await connection.command('AUTH', 'AUTH LOGIN', /^334/u);
  await connection.command('AUTH', Buffer.from(transport.user, 'utf8').toString('base64'), /^334/u);
  await connection.command(
    'AUTH',
    Buffer.from(transport.password, 'utf8').toString('base64'),
    /^235/u,
  );
}

function openSocket(transport: SmtpTransport, timeoutMs: number) {
  return new Promise<Socket | TLSSocket>((resolve, reject) => {
    const onTimeout = (socket: Socket | TLSSocket) => () => {
      socket.destroy(new Error('SMTP_TIMEOUT'));
    };
    if (transport.tls === 'none') {
      const socket = connectTcp({ host: transport.host, port: transport.port }, () =>
        resolve(socket),
      );
      socket.once('error', reject);
      socket.setTimeout(timeoutMs, onTimeout(socket));
      return;
    }
    const socket = connectTls(
      { host: transport.host, port: transport.port, servername: transport.host },
      () => resolve(socket),
    );
    socket.once('error', reject);
    socket.setTimeout(timeoutMs, onTimeout(socket));
  });
}

export type SmtpSession = Readonly<{
  /** Sends one message on the open connection; a refused message leaves the session usable. */
  send(message: SmtpMessage): Promise<string>;
  quit(): void;
}>;

/**
 * Minimal SMTP client for transactional auth mail: implicit TLS (port 465)
 * or plain TCP for a local relay, AUTH PLAIN/LOGIN, one recipient per
 * message. The connection, EHLO and AUTH happen once per session, so a drain
 * of ten messages costs one TLS handshake instead of ten.
 */
export async function openSmtpSession(transport: SmtpTransport): Promise<SmtpSession> {
  const timeoutMs = transport.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await openSocket(transport, timeoutMs);
  const connection = new SmtpConnection(socket);
  const heloName = transport.user.includes('@') ? transport.user.split('@')[1] : 'safetyhub.kz';
  try {
    const greeting = await connection.read();
    if (!greeting.startsWith('220')) throw new SmtpError('GREETING', greeting);
    const capabilities = await connection.command('EHLO', `EHLO ${heloName}`, /^250/u);
    await authenticate(connection, transport, capabilities);
  } catch (error) {
    connection.destroy();
    throw error;
  }

  let busy = false;
  return {
    async send(message) {
      if (busy) throw new Error('SMTP_SESSION_BUSY');
      if (!connection.alive) throw new Error('SMTP_CONNECTION_CLOSED');
      busy = true;
      const mime = buildMimeMessage(message);
      try {
        await connection.command('MAIL', `MAIL FROM:<${message.from}>`, /^250/u);
        await connection.command('RCPT', `RCPT TO:<${message.to}>`, /^25[01]/u);
        await connection.command('DATA', 'DATA', /^354/u);
        // Dot-stuffing is unnecessary: the body is base64 and the headers are ours.
        const accepted = await connection.command('BODY', `${mime}\r\n.`, /^250/u);
        return accepted.trim();
      } catch (error) {
        // Abort the half-built envelope so the next message starts clean.
        if (connection.alive) {
          await connection.command('RSET', 'RSET', /^250/u).catch(() => connection.destroy());
        }
        throw error;
      } finally {
        busy = false;
      }
    },
    quit() {
      connection.quit();
    },
  };
}

/** One message on a fresh connection. */
export async function sendSmtpMail(transport: SmtpTransport, message: SmtpMessage) {
  const session = await openSmtpSession(transport);
  try {
    return await session.send(message);
  } finally {
    session.quit();
  }
}
