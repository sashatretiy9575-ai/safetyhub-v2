import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import type { NextRequest, NextResponse as FrameworkNextResponse } from 'next/server';
import { RateLimitError } from '@/server/security/rate-limit';
import { createAdminClient } from '@/server/supabase/admin';

const EMAIL_OTP_CHALLENGE_COOKIE = 'safetyhub-email-otp-challenge';
const EMAIL_OTP_CHALLENGE_MAX_AGE_SECONDS = 3600;
const EMAIL_OTP_CHALLENGE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

type JsonRecord = Record<string, unknown>;

export type EmailOtpChallengeConsumption =
  | { outcome: 'allowed'; attemptsRemaining: number }
  | { outcome: 'exhausted'; retryAfter: number }
  | { outcome: 'invalid' };

export type EmailOtpRequestGate =
  | { allowed: true; purgedUserId: string | null }
  | { allowed: false; reason: 'address_cooldown'; retryAfter: number };

type GatewayRpcClient = {
  rpc(
    name: 'begin_email_otp_request' | 'begin_email_otp_verify',
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

// Anti-abuse identifiers must not be derived from the database service key:
// rotating that key would silently invalidate every in-flight OTP challenge
// and reset the quota counters that hold an attacker back. The variable is
// documented in .env.example and required in every deployed environment.
function challengeHmacSecret() {
  const secret = process.env.RATE_LIMIT_HMAC_SECRET;
  if (!secret || secret.length < 32) throw new Error('RATE_LIMIT_HMAC_SECRET_REQUIRED');
  return secret;
}

function challengeHash(kind: 'challenge' | 'email', value: string) {
  return createHmac('sha256', challengeHmacSecret())
    .update(`safetyhub:email-otp-challenge:v1:${kind}:${value}`, 'utf8')
    .digest('hex');
}

function challengeHashes(token: string, email: string) {
  return {
    challengeHash: challengeHash('challenge', token),
    emailHash: challengeHash('email', email.trim().toLowerCase()),
  };
}

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function retryAfterSeconds(value: unknown) {
  return Math.max(1, Math.ceil(Number(value) || 1));
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function readEmailOtpChallengeCookie(request: NextRequest) {
  const token = request.cookies.get(EMAIL_OTP_CHALLENGE_COOKIE)?.value ?? '';
  return EMAIL_OTP_CHALLENGE_TOKEN.test(token) ? token : null;
}

export function setEmailOtpChallengeCookie(response: FrameworkNextResponse, token: string) {
  if (!EMAIL_OTP_CHALLENGE_TOKEN.test(token)) throw new Error('OTP_CHALLENGE_TOKEN_INVALID');
  response.cookies.set(EMAIL_OTP_CHALLENGE_COOKIE, token, {
    ...cookieOptions(),
    maxAge: EMAIL_OTP_CHALLENGE_MAX_AGE_SECONDS,
  });
  return response;
}

export function clearEmailOtpChallengeCookie(response: FrameworkNextResponse) {
  response.cookies.set(EMAIL_OTP_CHALLENGE_COOKIE, '', {
    ...cookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
  return response;
}

/**
 * Everything that must be settled before Auth is asked to send a code, in one
 * round-trip: the network quota (a refusal surfaces as RateLimitError), the
 * one-code-per-minute cooldown of the address, and the sweep of a
 * self-deletion the old staged path left half-done for this email.
 */
export async function beginEmailOtpRequest(
  ipHash: string,
  email: string,
): Promise<EmailOtpRequestGate> {
  const normalizedEmail = email.trim().toLowerCase();
  const client = createAdminClient() as unknown as GatewayRpcClient;
  const { data, error } = await client.rpc('begin_email_otp_request', {
    p_ip_hash: ipHash,
    p_email: normalizedEmail,
    p_email_hash: challengeHash('email', normalizedEmail),
  });
  if (error) throw new Error('OTP_UNAVAILABLE');
  const payload = jsonRecord(data);
  if (payload?.allowed === true) {
    return {
      allowed: true,
      purgedUserId: typeof payload.purgedUserId === 'string' ? payload.purgedUserId : null,
    };
  }
  if (payload?.reason === 'address_cooldown') {
    return {
      allowed: false,
      reason: 'address_cooldown',
      retryAfter: retryAfterSeconds(payload.retryAfter),
    };
  }
  // Anything else is the network quota; an unknown shape fails closed the same way.
  throw new RateLimitError(retryAfterSeconds(payload?.retryAfter));
}

export async function issueEmailOtpChallenge(email: string) {
  const token = randomBytes(32).toString('base64url');
  const hashes = challengeHashes(token, email);
  const { data, error } = await createAdminClient().rpc('issue_email_otp_challenge', {
    p_challenge_hash: hashes.challengeHash,
    p_email_hash: hashes.emailHash,
    p_expires_in_seconds: EMAIL_OTP_CHALLENGE_MAX_AGE_SECONDS,
  });
  if (error || jsonRecord(data)?.issued !== true) throw new Error('OTP_CHALLENGE_UNAVAILABLE');
  return token;
}

/**
 * The network quota and one attempt of the browser's receipt, in one
 * round-trip. A quota refusal surfaces as RateLimitError before the receipt
 * is touched.
 */
export async function beginEmailOtpVerify(
  ipHash: string,
  token: string,
  email: string,
): Promise<EmailOtpChallengeConsumption> {
  const hashes = challengeHashes(token, email);
  const client = createAdminClient() as unknown as GatewayRpcClient;
  const { data, error } = await client.rpc('begin_email_otp_verify', {
    p_ip_hash: ipHash,
    p_challenge_hash: hashes.challengeHash,
    p_email_hash: hashes.emailHash,
  });
  if (error) throw new Error('OTP_CHALLENGE_UNAVAILABLE');
  const payload = jsonRecord(data);
  if (payload?.allowed === true) {
    return {
      outcome: 'allowed',
      attemptsRemaining: Math.max(0, Math.floor(Number(payload.attemptsRemaining) || 0)),
    };
  }
  if (payload?.reason === 'rate_limited') {
    throw new RateLimitError(retryAfterSeconds(payload.retryAfter));
  }
  if (payload?.reason === 'exhausted') {
    return { outcome: 'exhausted', retryAfter: retryAfterSeconds(payload.retryAfter) };
  }
  return { outcome: 'invalid' };
}

export async function completeEmailOtpChallenge(token: string, email: string) {
  const hashes = challengeHashes(token, email);
  const { data, error } = await createAdminClient().rpc('complete_email_otp_challenge', {
    p_challenge_hash: hashes.challengeHash,
    p_email_hash: hashes.emailHash,
  });
  if (error) throw new Error('OTP_CHALLENGE_UNAVAILABLE');
  return data === true;
}
