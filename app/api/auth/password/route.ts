import { NextResponse } from '@/lib/security/api-response';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse as FrameworkNextResponse } from 'next/server';
import {
  clearPasswordContextCookie,
  consumePasswordChangeContext,
  createEphemeralAuthClient,
  verifiedSessionId,
} from '@/features/auth/password-change';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/types';
import { passwordChangeRequestSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';

function authFailure(error: { code?: string; status?: number } | null, fallback: string) {
  if (error?.code === 'captcha_failed') {
    return NextResponse.json({ error: 'CAPTCHA_FAILED' }, { status: 400 });
  }
  if (error?.status === 429) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }
  if (!error?.status || error.status >= 500) {
    return NextResponse.json({ error: 'AUTH_UNAVAILABLE' }, { status: 503 });
  }
  return NextResponse.json({ error: fallback }, { status: 400 });
}

async function revokeOtherSessions(client: SupabaseClient<Database>) {
  const others = await client.auth.signOut({ scope: 'others' });
  if (!others.error) return { sessionsRevoked: true, signedOut: false };
  const global = await client.auth.signOut({ scope: 'global' });
  return global.error
    ? { sessionsRevoked: false, signedOut: false }
    : { sessionsRevoked: true, signedOut: true };
}

function clearPrivateDeviceState<T extends FrameworkNextResponse>(response: T): T {
  response.headers.set('Clear-Site-Data', '"cache", "storage"');
  return response;
}

export async function POST(request: Request) {
  let clearContext = false;
  const finish = <T extends FrameworkNextResponse>(response: T) => {
    if (clearContext) clearPasswordContextCookie(response);
    return response;
  };

  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    const parsed = passwordChangeRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    clearContext = parsed.data.mode === 'context';
    if (
      parsed.data.mode === 'current' &&
      Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) &&
      !parsed.data.captchaToken
    ) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    // Recovery and invite contexts are one-time and bound to this exact Auth session.
    const context = await requireUser({ enforceLegal: false });
    const supabase = await createClient();

    if (parsed.data.mode === 'current') {
      if (!context.user.email) {
        return NextResponse.json({ error: 'CURRENT_PASSWORD_UNAVAILABLE' }, { status: 400 });
      }
      const verifier = createEphemeralAuthClient();
      const signIn = await verifier.auth.signInWithPassword({
        email: context.user.email,
        password: parsed.data.currentPassword,
        options: { captchaToken: parsed.data.captchaToken },
      });
      if (signIn.error || !signIn.data.session || signIn.data.user?.id !== context.user.id) {
        return authFailure(signIn.error, 'CURRENT_PASSWORD_INVALID');
      }

      const updated = await verifier.auth.updateUser({
        password: parsed.data.password,
        current_password: parsed.data.currentPassword,
      });
      if (updated.error) return authFailure(updated.error, 'PASSWORD_CHANGE_REJECTED');

      const revocation = await revokeOtherSessions(verifier);
      if (revocation.signedOut) {
        await supabase.auth.signOut({ scope: 'local' });
        return clearPrivateDeviceState(NextResponse.json({ changed: true, ...revocation }));
      }

      const verifierSession = await verifier.auth.getSession();
      if (verifierSession.error || !verifierSession.data.session) {
        await supabase.auth.signOut({ scope: 'local' });
        return clearPrivateDeviceState(
          NextResponse.json({
            changed: true,
            sessionsRevoked: revocation.sessionsRevoked,
            signedOut: true,
          }),
        );
      }
      const persisted = await supabase.auth.setSession({
        access_token: verifierSession.data.session.access_token,
        refresh_token: verifierSession.data.session.refresh_token,
      });
      if (persisted.error) {
        await supabase.auth.signOut({ scope: 'local' });
        return clearPrivateDeviceState(
          NextResponse.json({
            changed: true,
            sessionsRevoked: revocation.sessionsRevoked,
            signedOut: true,
          }),
        );
      }
      return NextResponse.json({ changed: true, ...revocation });
    }

    const session = await supabase.auth.getSession();
    if (session.error || !session.data.session) {
      return finish(NextResponse.json({ error: 'PASSWORD_CONTEXT_INVALID' }, { status: 403 }));
    }
    const sessionId = await verifiedSessionId(
      supabase,
      session.data.session.access_token,
      context.user.id,
    );
    const consumed = await consumePasswordChangeContext(
      context.user.id,
      sessionId,
      parsed.data.contextKind,
    );
    if (!consumed) {
      return finish(NextResponse.json({ error: 'PASSWORD_CONTEXT_INVALID' }, { status: 403 }));
    }

    const updated = await supabase.auth.updateUser({ password: parsed.data.password });
    if (updated.error) {
      return finish(authFailure(updated.error, 'PASSWORD_CHANGE_REJECTED'));
    }
    const revocation = await revokeOtherSessions(supabase);
    const response = NextResponse.json({ changed: true, ...revocation });
    return finish(revocation.signedOut ? clearPrivateDeviceState(response) : response);
  } catch (error) {
    return finish(apiError(error));
  }
}
