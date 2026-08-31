import { NextResponse } from '@/lib/security/api-response';
import {
  claimPasswordChangeContext,
  inspectPasswordChangeContext,
  setPasswordContextCookie,
  verifiedSessionId,
} from '@/features/auth/password-change';
import {
  finalizeSignupLegalOperation,
  signupLegalCorrelationFromUserMetadata,
} from '@/features/auth/signup-legal';
import { createClient } from '@/lib/supabase/server';
import {
  authenticatedLandingPath,
  getSiteUrl,
  safeRedirectPath,
} from '@/features/auth/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const flowId = url.searchParams.get('sb_flow_id') ?? undefined;
  const passwordTicket = url.searchParams.get('password_ticket');
  const next = safeRedirectPath(url.searchParams.get('next'));
  const redirectOrigin = getSiteUrl();
  if (code) {
    const supabase = await createClient();
    let recoveryEvent = false;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recoveryEvent = true;
    });
    let exchange;
    try {
      exchange = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    } finally {
      subscription.unsubscribe();
    }
    const { data, error } = exchange;
    if (error && passwordTicket) {
      try {
        // Some mobile email clients open the same one-time link twice. The
        // first request may already have completed the PKCE exchange and bound
        // the recovery context before the duplicate consumes the same code.
        // Continue only when this browser already has that exact, session-bound
        // context; an unclaimed ticket or another user's session is rejected.
        const current = await supabase.auth.getSession();
        const session = current.data.session;
        if (session?.user) {
          const sessionId = await verifiedSessionId(
            supabase,
            session.access_token,
            session.user.id,
          );
          const context = await inspectPasswordChangeContext(session.user.id, sessionId);
          if (context?.kind === 'recovery' && context.token === passwordTicket) {
            const response = NextResponse.redirect(
              new URL('/auth/update-password', redirectOrigin),
            );
            setPasswordContextCookie(response, passwordTicket);
            return response;
          }
        }
      } catch {
        // The generic invalid confirmation redirect remains the safe fallback.
      }
    }
    if (!error && data.session && data.user) {
      if (passwordTicket) {
        try {
          const sessionId = await verifiedSessionId(
            supabase,
            data.session.access_token,
            data.user.id,
          );
          const claimed =
            recoveryEvent &&
            (await claimPasswordChangeContext(passwordTicket, 'recovery', data.user.id, sessionId));
          if (claimed) {
            const response = NextResponse.redirect(
              new URL('/auth/update-password', redirectOrigin),
            );
            setPasswordContextCookie(response, passwordTicket);
            return response;
          }
        } catch {
          // The recovery exchange is rejected below and its local session is removed.
        }
        await supabase.auth.signOut({ scope: 'local' });
        return NextResponse.redirect(
          new URL('/auth/reset-password?error=invalid-recovery', redirectOrigin),
        );
      }
      if (recoveryEvent) {
        await supabase.auth.signOut({ scope: 'local' });
        return NextResponse.redirect(
          new URL('/auth/reset-password?error=invalid-recovery', redirectOrigin),
        );
      }
      const signupCorrelation = signupLegalCorrelationFromUserMetadata(data.user.user_metadata);
      if (signupCorrelation) {
        let signupCompleted = false;
        try {
          const finalized = await finalizeSignupLegalOperation(signupCorrelation, data.user.id);
          signupCompleted = finalized.status === 'completed';
        } catch {
          // Finalization is idempotent and may be retried while the operation remains valid.
        }
        if (signupCompleted) {
          let refreshFailed = true;
          try {
            const refreshed = await supabase.auth.refreshSession();
            refreshFailed = Boolean(refreshed.error || !refreshed.data.session);
          } catch {
            // A session containing consumed signup metadata must not remain locally active.
          }
          if (refreshFailed) {
            try {
              await supabase.auth.signOut({ scope: 'local' });
            } catch {
              // The generic error redirect remains the only externally visible outcome.
            }
            return NextResponse.redirect(new URL('/auth/login?error=confirmation', redirectOrigin));
          }
        }
      }
      let destination = next;
      if (next === '/profile') {
        const { data: authContext } = await supabase.rpc('get_auth_context').maybeSingle();
        if (authContext?.role === 'admin' || authContext?.role === 'participant') {
          destination = authenticatedLandingPath(authContext.role);
        }
      }
      return NextResponse.redirect(new URL(destination, redirectOrigin));
    }
  }
  return NextResponse.redirect(new URL('/auth/login?error=confirmation', redirectOrigin));
}
