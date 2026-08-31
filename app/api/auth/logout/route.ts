import type { NextRequest, NextResponse as FrameworkNextResponse } from 'next/server';
import { NextResponse } from '@/lib/security/api-response';
import { clearPasswordContextCookie } from '@/features/auth/password-change';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { createClient } from '@/lib/supabase/server';
import {
  isSupabaseAuthCookieName,
  supabaseAuthCookieOptions,
} from '@/lib/supabase/auth-cookie-options';
import { readJsonBody } from '@/lib/security/request-body';

function clearLocalSession(
  request: NextRequest,
  response: FrameworkNextResponse,
) {
  const cookieOptions = supabaseAuthCookieOptions();
  for (const cookie of request.cookies.getAll()) {
    if (!isSupabaseAuthCookieName(cookie.name)) continue;
    response.cookies.set(cookie.name, '', {
      ...cookieOptions,
      expires: new Date(0),
      maxAge: 0,
    });
  }
  clearPasswordContextCookie(response);
  // Quiz drafts are intentionally stored on-device. A shared-device logout
  // must remove them (and private HTTP/Cache Storage entries) before another
  // person uses the same browser profile.
  response.headers.set('Clear-Site-Data', '"cache", "storage"');
  return response;
}

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
  return clearLocalSession(request, response);
}
