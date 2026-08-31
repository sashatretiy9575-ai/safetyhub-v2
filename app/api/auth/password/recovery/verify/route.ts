import { NextResponse } from '@/lib/security/api-response';
import {
  createEphemeralAuthClient,
  createVerifiedRecoveryContext,
  deletePasswordChangeContext,
  setPasswordContextCookie,
  verifiedSessionId,
} from '@/features/auth/password-change';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createClient } from '@/lib/supabase/server';
import { recoveryVerifySchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';

type AuthFailure = { code?: string; status?: number } | null;

function verificationFailure(error: AuthFailure) {
  if (error?.status === 429) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }
  if (!error?.status || error.status >= 500) {
    return NextResponse.json({ error: 'RECOVERY_UNAVAILABLE' }, { status: 503 });
  }
  return NextResponse.json({ error: 'RECOVERY_CODE_INVALID' }, { status: 400 });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    body = await readJsonBody(request);
  } catch (error) {
    return apiError(error);
  }

  const parsed = recoveryVerifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  let ticket: string | null = null;
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  let persistenceStarted = false;
  try {
    const verifier = createEphemeralAuthClient();
    const verified = await verifier.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: 'recovery',
    });
    if (verified.error) return verificationFailure(verified.error);

    const { session, user } = verified.data;
    if (!session || !user?.email || user.email.trim().toLowerCase() !== parsed.data.email) {
      return NextResponse.json({ error: 'RECOVERY_CODE_INVALID' }, { status: 400 });
    }

    const sessionId = await verifiedSessionId(verifier, session.access_token, user.id);
    ticket = await createVerifiedRecoveryContext(user.id, sessionId);

    supabase = await createClient();
    persistenceStarted = true;
    const persisted = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (persisted.error || !persisted.data.session || persisted.data.user?.id !== user.id) {
      throw new Error('RECOVERY_SESSION_PERSIST_FAILED');
    }
    const persistedSessionId = await verifiedSessionId(
      supabase,
      persisted.data.session.access_token,
      user.id,
    );
    if (persistedSessionId !== sessionId) {
      throw new Error('RECOVERY_SESSION_MISMATCH');
    }

    const response = NextResponse.json({ verified: true });
    setPasswordContextCookie(response, ticket);
    return response;
  } catch {
    if (ticket) {
      await deletePasswordChangeContext(ticket).catch(() => undefined);
    }
    if (supabase && persistenceStarted) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
    return NextResponse.json({ error: 'RECOVERY_UNAVAILABLE' }, { status: 503 });
  }
}
