import 'server-only';

import type { NextResponse } from 'next/server';
import { SAFETYHUB_SESSION_HINT_COOKIE } from '@/lib/supabase/session-cleanup';

// Keep this client-only convenience hint as durable as the Supabase SSR
// cookie's default. It remains non-authoritative and is cleared whenever the
// local SafetyHub session is cleared, but a browser restart must not turn a
// still-valid persisted session into a guest-only locale transition.
const SESSION_HINT_MAX_AGE = 400 * 24 * 60 * 60;

function requestUsesHttps(request: Pick<Request, 'headers' | 'url'>) {
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim();
  if (forwardedProtocol === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A deliberately non-authoritative UI hint. It contains neither identity nor
 * role data and is set only after the corresponding auth flow persisted a
 * real server session. Authorization must continue to read Supabase on the
 * server, and every local sign-out clears this cookie.
 */
export function setSafetyHubSessionHint<ResponseType extends NextResponse>(
  request: Pick<Request, 'headers' | 'url'>,
  response: ResponseType,
) {
  response.cookies.set(SAFETYHUB_SESSION_HINT_COOKIE, '1', {
    httpOnly: false,
    secure: requestUsesHttps(request),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_HINT_MAX_AGE,
  });
  return response;
}
