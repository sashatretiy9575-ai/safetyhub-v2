import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';
import { emailOtpStartSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { authProviderRetryAfter } from '@/features/auth/otp-rate-limit';
import { emailOtpRedirectUrl } from '@/features/auth/email-otp-locale';
import { resolveSiteOrigin } from '@/lib/site-url';
import {
  issueEmailOtpChallenge,
  setEmailOtpChallengeCookie,
} from '@/lib/security/email-otp-challenge';

type AuthProviderError = { code?: string; status?: number } | null;

function providerFailure(error: AuthProviderError) {
  if (error?.status === 429) {
    const retryAfter = authProviderRetryAfter(error);
    return NextResponse.json(
      { error: 'RATE_LIMITED', retryAfter },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
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
    await consumeCoarseQuota('auth.otp.start', security.ipHash);
    const locale = parsed.data.locale ?? 'ru';

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
