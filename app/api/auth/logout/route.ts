import type { NextRequest } from 'next/server';
import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createClient } from '@/lib/supabase/server';
import { clearSafetyHubLocalSession } from '@/lib/supabase/session-cleanup';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }
  const body = (await readJsonBody(request).catch(() => null)) as { scope?: unknown } | null;
  const scope = body?.scope === 'global' ? 'global' : 'local';
  let signOutFailed = false;
  try {
    const client = await createClient();
    const { error } = await client.auth.signOut({ scope });
    signOutFailed = Boolean(error);
  } catch {
    signOutFailed = true;
  }

  const response =
    scope === 'global' && signOutFailed
      ? NextResponse.json({ error: 'AUTH_UNAVAILABLE' }, { status: 503 })
      : NextResponse.json({ signedOut: true });
  return clearSafetyHubLocalSession(request, response);
}
