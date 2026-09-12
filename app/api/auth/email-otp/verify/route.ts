import type { NextRequest } from 'next/server';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { createEphemeralAuthClient } from '@/server/supabase/ephemeral-auth';
import { createClient } from '@/server/supabase/server';
import { setSafetyHubSessionHint } from '@/server/supabase/session-hint';
import { clearSafetyHubLocalSession } from '@/lib/supabase/session-cleanup';
import { emailOtpVerifySchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { classifyAuthProviderError } from '@/lib/auth/otp-rate-limit';
import { localizedAccountPath } from '@/lib/auth/email-otp-locale';
import type { EmailOtpLocale } from '@/lib/auth/email-otp-locale';
import { getCurrentLegalPolicies, type CurrentLegalPolicies } from '@/server/legal';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import {
  beginEmailOtpVerify,
  clearEmailOtpChallengeCookie,
  completeEmailOtpChallenge,
  readEmailOtpChallengeCookie,
} from '@/server/security/email-otp-challenge';

type AuthProviderError = { code?: string; message?: string; status?: number } | null;

function throttledResponse(code: string, retryAfter: number) {
  return NextResponse.json(
    { error: code, retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}

function verificationFailure(error: AuthProviderError) {
  if (error?.status === 429) {
    const throttle = classifyAuthProviderError(error);
    return throttledResponse(throttle.code, throttle.retryAfter);
  }
  if (!error?.status || error.status >= 500) {
    return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
  }
  return NextResponse.json({ error: 'OTP_CODE_INVALID' }, { status: 400 });
}

function invalidChallengeResponse() {
  return NextResponse.json({ error: 'OTP_CODE_INVALID' }, { status: 400 });
}

function landingPath(
  context: {
    role?: unknown;
    profile_onboarding_completed_at?: unknown;
  },
  locale: EmailOtpLocale,
) {
  if (context.role === 'admin') return '/admin';
  return localizedAccountPath(
    context.profile_onboarding_completed_at === null ? '/onboarding' : '/profile',
    locale,
  );
}

function hasCurrentLegalReceipts(value: unknown, currentLegal: CurrentLegalPolicies) {
  if (!Array.isArray(value)) return false;
  const expected = [
    ['privacy', currentLegal.privacy.version],
    ['terms', currentLegal.terms.version],
  ] as const;
  return expected.every(([documentType, version]) =>
    value.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).documentType === documentType &&
        (entry as Record<string, unknown>).version === version,
    ),
  );
}

async function clearPersistedSession(
  request: NextRequest,
  supabase: Awaited<ReturnType<typeof createClient>>,
  error: string,
) {
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  return clearEmailOtpChallengeCookie(
    clearSafetyHubLocalSession(request, NextResponse.json({ error }, { status: 503 })),
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
    const locale = parsed.data.locale ?? 'ru';
    const challengeToken = readEmailOtpChallengeCookie(request);
    if (!challengeToken) {
      return clearEmailOtpChallengeCookie(invalidChallengeResponse());
    }

    // The network quota and one attempt of the browser's receipt are one
    // round-trip; a quota refusal is a 429 through apiError.
    let challenge;
    try {
      challenge = await beginEmailOtpVerify(security.ipHash, challengeToken, parsed.data.email);
    } catch (error) {
      if (error instanceof Error && error.message === 'OTP_CHALLENGE_UNAVAILABLE') {
        return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
      }
      throw error;
    }
    if (challenge.outcome === 'invalid') {
      return clearEmailOtpChallengeCookie(invalidChallengeResponse());
    }
    if (challenge.outcome === 'exhausted') {
      return clearEmailOtpChallengeCookie(throttledResponse('RATE_LIMITED', challenge.retryAfter));
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
      challengeCompleted = await completeEmailOtpChallenge(challengeToken, parsed.data.email);
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

    // The profile RPC is the only server-authorized locale write. Auth user
    // metadata is not a display-locale source of truth and a parallel update
    // can race the realm boundary during a fresh session transition.
    const { error: profileLocaleError } = await supabase.rpc('set_preferred_locale', {
      p_locale: locale,
    });
    if (profileLocaleError) {
      return clearPersistedSession(request, supabase, 'AUTH_CONTEXT_UNAVAILABLE');
    }

    // A successful OTP is the first moment the ordinary realm records the
    // compact, preselected acknowledgement. The immutable receipt must be
    // durable before this freshly persisted session can reach a private page.
    let currentLegal: CurrentLegalPolicies;
    try {
      currentLegal = await getCurrentLegalPolicies();
    } catch {
      return clearPersistedSession(request, supabase, 'AUTH_CONTEXT_UNAVAILABLE');
    }
    const legalResult = await supabase.rpc('accept_current_legal_documents', {
      p_privacy_version: currentLegal.privacy.version,
      p_privacy_body_revision: currentLegal.privacy.bodyRevision,
      p_terms_version: currentLegal.terms.version,
      p_terms_body_revision: currentLegal.terms.bodyRevision,
    });
    try {
      const receipts = unwrapRpcMutationResponse(legalResult);
      if (!hasCurrentLegalReceipts(receipts, currentLegal)) {
        return clearPersistedSession(request, supabase, 'AUTH_CONTEXT_UNAVAILABLE');
      }
    } catch {
      return clearPersistedSession(request, supabase, 'AUTH_CONTEXT_UNAVAILABLE');
    }

    const { data: authContext, error: authContextError } = await supabase
      .rpc('get_auth_context')
      .maybeSingle();
    if (!authContext || authContextError) {
      return clearPersistedSession(request, supabase, 'AUTH_CONTEXT_UNAVAILABLE');
    }
    if (authContext.has_current_legal_acceptance !== true) {
      return clearPersistedSession(request, supabase, 'AUTH_CONTEXT_UNAVAILABLE');
    }

    const response = clearEmailOtpChallengeCookie(
      NextResponse.json({
        verified: true,
        redirectTo: landingPath(authContext, locale),
      }),
    );
    return setSafetyHubSessionHint(request, response);
  } catch (error) {
    return apiError(error);
  }
}
