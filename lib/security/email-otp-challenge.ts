import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import type { NextRequest, NextResponse as FrameworkNextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const EMAIL_OTP_CHALLENGE_COOKIE = 'safetyhub-email-otp-challenge';
const EMAIL_OTP_CHALLENGE_MAX_AGE_SECONDS = 3600;
const EMAIL_OTP_CHALLENGE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

type JsonRecord = Record<string, unknown>;

export type EmailOtpChallengeConsumption =
  | { outcome: 'allowed'; attemptsRemaining: number }
  | { outcome: 'exhausted'; retryAfter: number }
  | { outcome: 'invalid' };

function challengeHmacSecret() {
  const secret = process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.SUPABASE_SECRET_KEY;
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
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
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

export async function consumeEmailOtpChallengeAttempt(
  token: string,
  email: string,
): Promise<EmailOtpChallengeConsumption> {
  const hashes = challengeHashes(token, email);
  const { data, error } = await createAdminClient().rpc('consume_email_otp_challenge_attempt', {
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
  if (payload?.reason === 'exhausted') {
    return {
      outcome: 'exhausted',
      retryAfter: Math.max(1, Math.ceil(Number(payload.retryAfter) || 1)),
    };
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
