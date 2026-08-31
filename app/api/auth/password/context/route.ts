import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import {
  claimPasswordChangeContext,
  createEphemeralAuthClient,
  setPasswordContextCookie,
  verifiedSessionId,
} from '@/features/auth/password-change';
import { createClient } from '@/lib/supabase/server';
import { invitePasswordContextSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    const parsed = invitePasswordContextSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const verifier = createEphemeralAuthClient();
    const { data: userData, error: userError } = await verifier.auth.getUser(
      parsed.data.accessToken,
    );
    if (userError || !userData.user) {
      return NextResponse.json({ error: 'INVITE_CONTEXT_INVALID' }, { status: 403 });
    }
    const sessionId = await verifiedSessionId(verifier, parsed.data.accessToken, userData.user.id);
    const claimed = await claimPasswordChangeContext(
      parsed.data.ticket,
      'invite',
      userData.user.id,
      sessionId,
    );
    if (!claimed) {
      return NextResponse.json({ error: 'INVITE_CONTEXT_INVALID' }, { status: 403 });
    }

    const supabase = await createClient();
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: parsed.data.accessToken,
      refresh_token: parsed.data.refreshToken,
    });
    if (sessionError || !sessionData.session || sessionData.user?.id !== userData.user.id) {
      await supabase.auth.signOut({ scope: 'local' });
      return NextResponse.json({ error: 'INVITE_CONTEXT_INVALID' }, { status: 403 });
    }
    const persistedSessionId = await verifiedSessionId(
      supabase,
      sessionData.session.access_token,
      userData.user.id,
    );
    if (persistedSessionId !== sessionId) {
      await supabase.auth.signOut({ scope: 'local' });
      return NextResponse.json({ error: 'INVITE_CONTEXT_INVALID' }, { status: 403 });
    }

    const response = NextResponse.json({ ready: true });
    setPasswordContextCookie(response, parsed.data.ticket);
    return response;
  } catch {
    return NextResponse.json({ error: 'INVITE_CONTEXT_INVALID' }, { status: 403 });
  }
}
