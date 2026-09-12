import 'server-only';

import { resolveSiteOrigin } from '@/lib/site-url';

const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5_000;
const TURNSTILE_TOKEN_MAX_BYTES = 2_048;
const CLOUDFLARE_ALWAYS_PASS_TEST_SECRET = '1x0000000000000000000000000000000AA';

export class TurnstileVerificationUnavailableError extends Error {
  constructor() {
    super('TURNSTILE_VERIFICATION_UNAVAILABLE');
    this.name = 'TurnstileVerificationUnavailableError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function verificationSecret() {
  const secret = process.env.SAFETYHUB_TURNSTILE_SECRET_KEY?.trim();
  if (!secret) throw new TurnstileVerificationUnavailableError();
  if (
    (process.env.NODE_ENV === 'production' ||
      process.env.VERCEL_ENV === 'production' ||
      process.env.VERCEL_ENV === 'preview') &&
    secret === CLOUDFLARE_ALWAYS_PASS_TEST_SECRET
  ) {
    throw new TurnstileVerificationUnavailableError();
  }
  return secret;
}

function deploymentHostname() {
  const deployed =
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview';
  if (!deployed) return null;

  try {
    return new URL(resolveSiteOrigin()).hostname.toLowerCase();
  } catch {
    throw new TurnstileVerificationUnavailableError();
  }
}

export async function verifyTurnstileRegistrationToken(token: string) {
  const secret = verificationSecret();
  const expectedHostname = deploymentHostname();
  if (
    !token ||
    new TextEncoder().encode(token).byteLength > TURNSTILE_TOKEN_MAX_BYTES
  ) {
    return false;
  }

  const timeout = new AbortController();
  const timeoutId = setTimeout(() => timeout.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          secret,
          response: token,
        }),
        signal: timeout.signal,
      });
    } catch {
      throw new TurnstileVerificationUnavailableError();
    }
    if (!response.ok) throw new TurnstileVerificationUnavailableError();

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TurnstileVerificationUnavailableError();
    }
    const result = record(payload);
    if (!result) throw new TurnstileVerificationUnavailableError();
    if (result.success !== true) return false;

    // Local and CI use Cloudflare's public dummy pair, whose hostname is not a
    // deployment hostname. Deployed Vercel environments bind a successful
    // token to their configured canonical or preview hostname.
    if (!expectedHostname) return true;
    if (typeof result.hostname !== 'string') {
      throw new TurnstileVerificationUnavailableError();
    }
    return result.hostname.toLowerCase() === expectedHostname;
  } finally {
    clearTimeout(timeoutId);
  }
}
