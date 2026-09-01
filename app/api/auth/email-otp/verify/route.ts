import type { NextRequest } from 'next/server';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';
import { createClient } from '@/lib/supabase/server';
import { emailOtpVerifySchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { authProviderRetryAfter } from '@/features/auth/otp-rate-limit';
import { localizedAccountPath } from '@/features/auth/email-otp-locale';
import type { EmailOtpLocale } from '@/features/auth/email-otp-locale';
import {
  clearEmailOtpChallengeCookie,
  completeEmailOtpChallenge,
  consumeEmailOtpChallengeAttempt,
  readEmailOtpChallengeCookie,
} from '@/lib/security/email-otp-challenge';

type AuthProviderError = { code?: string; status?: number } | null;

function verificationFailure(error: AuthProviderError) {
  if (error?.status === 429) {
    const retryAfter = authProviderRetryAfter(error);
    return NextResponse.json(
      { error: 'RATE_LIMITED', retryAfter },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  if (!error?.status || error.status >= 500) {
    return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
  }
  return NextResponse.json({ error: 'OTP_CODE_INVALID' }, { status: 400 });
}

function invalidChallengeResponse() {
  return NextResponse.json({ error: 'OTP_CODE_INVALID' }, { status: 400 });
}

function exhaustedChallengeResponse(retryAfter: number) {
  return NextResponse.json(
    { error: 'RATE_LIMITED', retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}

function landingPath(context: {
  role?: unknown;
  profile_onboarding_completed_at?: unknown;
  has_current_legal_acceptance?: unknown;
}, locale: EmailOtpLocale) {
  if (context.has_current_legal_acceptance !== true)
    return localizedAccountPath('/auth/legal', locale);
  if (context.role === 'admin') return '/admin';
  return localizedAccountPath(
    context.profile_onboarding_completed_at === null ? '/onboarding' : '/profile',
    locale,
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = emailOtpVerifySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const security = requestSecurityMetadata(request);
    await consumeCoarseQuota('auth.otp.verify', security.ipHash);
    const locale = parsed.data.locale ?? 'ru';
    const challengeToken = readEmailOtpChallengeCookie(request);
    if (!challengeToken) {
      return clearEmailOtpChallengeCookie(invalidChallengeResponse());
    }

    let challenge;
    try {
      challenge = await consumeEmailOtpChallengeAttempt(challengeToken, parsed.data.email);
    } catch {
      return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
    }
    if (challenge.outcome === 'invalid') {
      return clearEmailOtpChallengeCookie(invalidChallengeResponse());
    }
    if (challenge.outcome === 'exhausted') {
      return clearEmailOtpChallengeCookie(
        exhaustedChallengeResponse(challenge.retryAfter),
      );
    }

    const verifier = createEphemeralAuthClient();
    const verified = await verifier.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: 'email',
    });
    if (verified.error) return verificationFailure(verified.error);

    const { session, user } = verified.data;
    if (!session || !user?.email || user.email.trim().toLowerCase() !== parsed.data.email) {
      try {
        await completeEmailOtpChallenge(challengeToken, parsed.data.email);
      } catch {
        // The Auth proof consumed the provider code. Fail closed and remove the
        // browser receipt even if durable invalidation is temporarily unavailable.
      }
      return clearEmailOtpChallengeCookie(invalidChallengeResponse());
    }

    let challengeCompleted: boolean;
    try {
      challengeCompleted = await completeEmailOtpChallenge(
        challengeToken,
        parsed.data.email,
      );
    } catch {
      return clearEmailOtpChallengeCookie(
        NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 }),
      );
    }
    if (!challengeCompleted) {
      return clearEmailOtpChallengeCookie(invalidChallengeResponse());
    }

    const supabase = await createClient();
    const persisted = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (persisted.error || !persisted.data.session || persisted.data.user?.id !== user.id) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return clearEmailOtpChallengeCookie(
        NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 }),
      );
    }

    const [{ error: profileLocaleError }, { error: metadataLocaleError }] = await Promise.all([
      supabase.rpc('set_preferred_locale', { p_locale: locale }),
      supabase.auth.updateUser({ data: { preferred_locale: locale } }),
    ]);
    if (profileLocaleError || metadataLocaleError) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return clearEmailOtpChallengeCookie(
        NextResponse.json({ error: 'AUTH_CONTEXT_UNAVAILABLE' }, { status: 503 }),
      );
    }

    const { data: authContext, error: authContextError } = await supabase
      .rpc('get_auth_context')
      .maybeSingle();
    if (!authContext || authContextError) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return clearEmailOtpChallengeCookie(
        NextResponse.json({ error: 'AUTH_CONTEXT_UNAVAILABLE' }, { status: 503 }),
      );
    }

    return clearEmailOtpChallengeCookie(
      NextResponse.json({
        verified: true,
        redirectTo: landingPath(authContext, locale),
      }),
    );
  } catch (error) {
    return apiError(error);
  }
}
