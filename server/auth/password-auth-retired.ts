import 'server-only';

import { NextResponse } from '@/lib/security/api-response';
import { getSiteUrl } from '@/server/auth/session';

export const PASSWORD_AUTH_RETIRED_ERROR = 'PASSWORD_AUTH_RETIRED';

export function passwordAuthRetiredResponse() {
  return NextResponse.json(
    {
      error: PASSWORD_AUTH_RETIRED_ERROR,
    },
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    },
  );
}

/**
 * Old confirmation, recovery, and invite links must never exchange a code or
 * create a session after password authentication is retired. The destination
 * intentionally discards the caller-controlled query and fragment state.
 */
export function redirectFromRetiredPasswordLink() {
  const response = NextResponse.redirect(new URL('/auth/login', getSiteUrl()), 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex');
  return response;
}
