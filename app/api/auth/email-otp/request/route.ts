import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { afterResponse } from '@/server/http/after-response';
import { createEphemeralAuthClient } from '@/server/supabase/ephemeral-auth';
import { emailOtpStartSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { classifyAuthProviderError, providerEmailsPerHour } from '@/lib/auth/otp-rate-limit';
import { emailOtpRedirectUrl } from '@/lib/auth/email-otp-locale';
import { sweepPurgedAccountStorage } from '@/server/auth/pending-self-deletion';
import { resolveSiteOrigin } from '@/lib/site-url';
import {
  beginEmailOtpRequest,
  issueEmailOtpChallenge,
  setEmailOtpChallengeCookie,
} from '@/server/security/email-otp-challenge';

type AuthProviderError = { code?: string; message?: string; status?: number } | null;

function throttledResponse(code: string, retryAfter: number) {
  return NextResponse.json(
    { error: code, retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}

function providerFailure(error: AuthProviderError) {
  if (error?.status === 429) {
    // The three provider refusals get three different messages on the form:
    // "your code is already on its way", "everybody is waiting for the hourly
    // budget" and the plain network quota.
    const throttle = classifyAuthProviderError(
      error,
      providerEmailsPerHour(process.env.SUPABASE_AUTH_EMAIL_SENT_PER_HOUR),
    );
    return throttledResponse(throttle.code, throttle.retryAfter);
  }
  if (error?.code === 'captcha_failed') {
    return NextResponse.json({ error: 'CAPTCHA_FAILED' }, { status: 400 });
  }
  if (!error?.status || error.status >= 500) {
    return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
  }

  // For all other Auth provider errors, including a non-existent login email,
  // deliberately continue through the same challenge-receipt path as a
  // successful request. This avoids turning either the response or cookie into
  // an account enumeration oracle.
  return null;
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = emailOtpStartSchema.safeParse(await readJsonBody(request));
    if (
      !parsed.success ||
      (Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && !parsed.data.captchaToken)
    ) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const security = requestSecurityMetadata(request);
    const locale = parsed.data.locale ?? 'ru';

    // One round-trip settles the network quota (a refusal is a 429 through
    // apiError), the one-code-per-minute cooldown of the address, and a
    // self-deletion the old staged path never finished for this email, so the
    // sign-in below creates a brand-new account instead of reviving one the
    // database refuses to serve.
    const gate = await beginEmailOtpRequest(security.ipHash, parsed.data.email);
    if (!gate.allowed) return throttledResponse('ADDRESS_COOLDOWN', gate.retryAfter);
    if (gate.purgedUserId) {
      const purgedUserId = gate.purgedUserId;
      afterResponse(() => void sweepPurgedAccountStorage(purgedUserId));
    }

    // Both public entry pages are one passwordless email-code gateway. Let the
    // provider create an unknown address so a login attempt never turns into a
    // silent no-email response. Supabase is the sole Turnstile verifier; only
    // the network quota runs before that proof, so an attacker cannot spend a
    // victim-wide email budget with invalid CAPTCHA tokens.
    const { error } = await createEphemeralAuthClient().auth.signInWithOtp({
      email: parsed.data.email,
      options: {
        shouldCreateUser: true,
        captchaToken: parsed.data.captchaToken,
        emailRedirectTo: emailOtpRedirectUrl(resolveSiteOrigin(), locale),
        data: { locale },
      },
    });
    if (error) {
      const failure = providerFailure(error);
      if (failure) return failure;
    }

    let challengeToken: string;
    try {
      challengeToken = await issueEmailOtpChallenge(parsed.data.email);
    } catch {
      return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
    }

    return setEmailOtpChallengeCookie(
      NextResponse.json({ sent: true }, { status: 202 }),
      challengeToken,
    );
  } catch (error) {
    return apiError(error);
  }
}
