import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createClient } from '@/lib/supabase/server';
import {
  finalizeSignupLegalOperation,
  signupLegalCorrelationFromUserMetadata,
} from '@/features/auth/signup-legal';
import { signInSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { authenticatedLandingPath } from '@/features/auth/server';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = signInSchema.safeParse(await readJsonBody(request));
    if (
      !parsed.success ||
      (Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && !parsed.data.captchaToken)
    ) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
      options: { captchaToken: parsed.data.captchaToken },
    });
    if (error) {
      return NextResponse.json({ error: 'INVALID_CREDENTIALS' }, { status: 400 });
    }
    const signupCorrelation = signupLegalCorrelationFromUserMetadata(data.user.user_metadata);
    if (signupCorrelation) {
      try {
        const finalized = await finalizeSignupLegalOperation(signupCorrelation, data.user.id);
        if (finalized.status === 'completed') {
          const refreshed = await supabase.auth.refreshSession();
          if (refreshed.error || !refreshed.data.session) {
            await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
            return NextResponse.json({ error: 'SIGNUP_FINALIZATION_UNAVAILABLE' }, { status: 503 });
          }
        }
      } catch {
        // The correlation remains in Auth metadata and a later login can retry.
      }
    }
    const { data: authContext, error: authContextError } = await supabase
      .rpc('get_auth_context')
      .maybeSingle();
    if (
      authContextError ||
      !authContext ||
      (authContext.role !== 'admin' && authContext.role !== 'participant')
    ) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      return NextResponse.json({ error: 'AUTH_CONTEXT_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({
      ok: true,
      redirectTo: authenticatedLandingPath(authContext.role),
    });
  } catch (error) {
    return apiError(error);
  }
}
