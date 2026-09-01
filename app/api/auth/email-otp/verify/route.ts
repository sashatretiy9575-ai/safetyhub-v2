import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';
import { createClient } from '@/lib/supabase/server';
import { emailOtpVerifySchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata, requestSubjectHash } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { authProviderRetryAfter } from '@/features/auth/otp-rate-limit';

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

function landingPath(context: {
  role?: unknown;
  profile_onboarding_completed_at?: unknown;
  has_current_legal_acceptance?: unknown;
}) {
  if (context.has_current_legal_acceptance !== true) return '/auth/legal';
  if (context.role === 'admin') return '/admin';
  return context.profile_onboarding_completed_at === null ? '/onboarding' : '/profile';
}

export async function POST(request: Request) {
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
    await consumeCoarseQuota('auth.otp.verify.email', requestSubjectHash(parsed.data.email));

    const verifier = createEphemeralAuthClient();
    const verified = await verifier.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: 'email',
    });
    if (verified.error) return verificationFailure(verified.error);

    const { session, user } = verified.data;
    if (!session || !user?.email || user.email.trim().toLowerCase() !== parsed.data.email) {
      return NextResponse.json({ error: 'OTP_CODE_INVALID' }, { status: 400 });
    }

    const supabase = await createClient();
    const persisted = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (persisted.error || !persisted.data.session || persisted.data.user?.id !== user.id) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return NextResponse.json({ error: 'OTP_UNAVAILABLE' }, { status: 503 });
    }

    const { data: authContext, error: authContextError } = await supabase
      .rpc('get_auth_context')
      .maybeSingle();
    if (!authContext || authContextError) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return NextResponse.json({ error: 'AUTH_CONTEXT_UNAVAILABLE' }, { status: 503 });
    }

    return NextResponse.json({
      verified: true,
      redirectTo: landingPath(authContext),
    });
  } catch (error) {
    return apiError(error);
  }
}
