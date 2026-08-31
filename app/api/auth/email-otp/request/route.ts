import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';
import { emailOtpStartSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata, requestSubjectHash } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';

type AuthProviderError = { code?: string; status?: number } | null;

function providerFailure(error: AuthProviderError) {
  if (error?.status === 429) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }
  if (error?.code === 'captcha_failed') {
    return NextResponse.json({ error: 'CAPTCHA_FAILED' }, { status: 400 });
  }
  if (!error?.status || error.status >= 500) {
    return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
  }

  // For all other Auth provider errors, including a non-existent login email,
  // deliberately return the same answer as a successful request. This avoids
  // turning the passwordless endpoint into an account enumeration oracle.
  return NextResponse.json({ sent: true }, { status: 202 });
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
    await consumeCoarseQuota('auth.otp.start.email', requestSubjectHash(parsed.data.email));

    // Native passwordless signup keeps CAPTCHA verification, email delivery,
    // and identity creation in the Auth provider's single flow. Never create
    // a user through the service role from this public endpoint.
    const { error } = await createEphemeralAuthClient().auth.signInWithOtp({
      email: parsed.data.email,
      options: {
        shouldCreateUser: parsed.data.intent === 'register',
        captchaToken: parsed.data.captchaToken,
      },
    });
    if (error) return providerFailure(error);

    return NextResponse.json({ sent: true }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
