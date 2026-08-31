import { NextResponse, type NextRequest } from 'next/server';
import { PROTECTED_PATTERNS } from './lib/constants';
import { buildContentSecurityPolicy } from './lib/security/content-security-policy';
import { resolveSiteOrigin } from './lib/site-url';
import { updateSession } from './lib/supabase/middleware';

function hasSupabaseAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith('sb-') && cookie.name.includes('auth-token'));
}

function loginUrl(request: NextRequest) {
  const url = new URL('/auth/login', resolveSiteOrigin());
  url.searchParams.set('return', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return url;
}

function loginRedirect(request: NextRequest) {
  return NextResponse.redirect(loginUrl(request));
}

function redirectWithCookies(url: URL, source: NextResponse) {
  const redirect = NextResponse.redirect(url);
  source.cookies.getAll().forEach(({ name, value, ...options }) => {
    redirect.cookies.set(name, value, options);
  });
  return redirect;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PATTERNS.some((pattern) => pattern.test(pathname));
  const needsNonce = isProtected || pathname.startsWith('/auth');
  const nonce = needsNonce ? crypto.randomUUID().replaceAll('-', '') : null;
  const csp = nonce ? buildContentSecurityPolicy({ nonce, strict: true }) : null;
  const requestHeaders = new Headers(request.headers);
  if (nonce && csp) {
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
  }
  const secure = <T extends NextResponse>(response: T): T => {
    if (csp) response.headers.set('Content-Security-Policy', csp);
    return response;
  };

  if (!hasSupabaseAuthCookie(request)) {
    return isProtected
      ? secure(loginRedirect(request))
      : secure(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  // Public routes stay CDN-cheap even when a stale or attacker-supplied cookie
  // is present. Protected handlers repeat authorization before every mutation.
  if (!isProtected) {
    return secure(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const { response, user } = await updateSession(request, requestHeaders);

  if (!user) {
    return secure(redirectWithCookies(loginUrl(request), response));
  }

  // Role, account status, and capabilities are resolved once through the
  // actor-bound get_auth_context RPC in the protected React tree.
  return secure(response);
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|.*\\..*).*)'],
};
