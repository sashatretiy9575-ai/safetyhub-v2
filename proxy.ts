import { NextResponse, type NextRequest } from 'next/server';
import {
  DEFAULT_LOCALE,
  htmlLanguage,
  isLocaleRoutablePath,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  LOCALE_HEADER_NAME,
  localizePathname,
  REQUEST_PATHNAME_HEADER_NAME,
  resolvePreferredLocale,
  splitLocalePathname,
  type AppLocale,
} from './i18n/config';
import { PROTECTED_PATTERNS } from './lib/constants';
import { buildContentSecurityPolicy } from './lib/security/content-security-policy';
import { rolloutFeatureEnabled } from './lib/release/rollout-flags';
import { resolveSiteOrigin } from './lib/site-url';
import { updateSession } from './lib/supabase/middleware';

function hasSupabaseAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith('sb-') && cookie.name.includes('auth-token'));
}

function loginUrl(request: NextRequest, locale: AppLocale) {
  const url = new URL('/auth/login', resolveSiteOrigin());
  url.pathname = localizePathname(url.pathname, locale);
  url.searchParams.set('return', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return url;
}

function loginRedirect(request: NextRequest, locale: AppLocale) {
  return NextResponse.redirect(loginUrl(request, locale));
}

function redirectWithCookies(url: URL, source: NextResponse) {
  const redirect = NextResponse.redirect(url);
  source.cookies.getAll().forEach(({ name, value, ...options }) => {
    redirect.cookies.set(name, value, options);
  });
  return redirect;
}

function copyResponseState(target: NextResponse, source: NextResponse) {
  source.cookies.getAll().forEach(({ name, value, ...options }) => {
    target.cookies.set(name, value, options);
  });
  source.headers.forEach((value, name) => {
    if (
      name.toLowerCase() !== 'set-cookie' &&
      name.toLowerCase() !== 'x-middleware-next' &&
      name.toLowerCase() !== 'x-middleware-rewrite'
    ) {
      target.headers.set(name, value);
    }
  });
  return target;
}

function applicationResponse(
  request: NextRequest,
  requestHeaders: Headers,
  pathname: string,
  source?: NextResponse,
) {
  if (pathname === request.nextUrl.pathname) {
    return source ?? NextResponse.next({ request: { headers: requestHeaders } });
  }

  const destination = request.nextUrl.clone();
  destination.pathname = pathname;
  const rewrite = NextResponse.rewrite(destination, { request: { headers: requestHeaders } });
  return source ? copyResponseState(rewrite, source) : rewrite;
}

function persistLocale(response: NextResponse, request: NextRequest, locale: AppLocale) {
  if (request.cookies.get(LOCALE_COOKIE_NAME)?.value === locale) return response;
  response.cookies.set(LOCALE_COOKIE_NAME, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
  });
  return response;
}

export async function proxy(request: NextRequest) {
  const externalPathname = request.nextUrl.pathname;
  const localizedPath = splitLocalePathname(externalPathname);
  const localeRoutable = isLocaleRoutablePath(localizedPath.pathname);
  const localeRoutesEnabled = rolloutFeatureEnabled('localeRoutes');

  // A compatible production build can be deployed before the translated
  // catalog is published. Until the explicit cutover, prefixed routes remain
  // physically unresolved and therefore return the App Router 404.
  if (!localeRoutesEnabled && localizedPath.hasLocalePrefix && localeRoutable) {
    return NextResponse.next();
  }

  // Locale-prefixed API, admin, metadata and immutable asset aliases do not
  // exist. Let the App Router return 404 instead of widening those surfaces.
  if (localizedPath.hasLocalePrefix && !localeRoutable) {
    return NextResponse.next();
  }

  // `ru` is the default locale and therefore has no public prefix. Collapse a
  // manually entered `/ru/...` alias instead of creating duplicate URLs.
  if (
    localizedPath.hasLocalePrefix &&
    localizedPath.locale === DEFAULT_LOCALE &&
    localeRoutable &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const destination = request.nextUrl.clone();
    destination.pathname = localizedPath.pathname;
    return persistLocale(NextResponse.redirect(destination), request, DEFAULT_LOCALE);
  }

  if (
    localeRoutesEnabled &&
    !localizedPath.hasLocalePrefix &&
    localeRoutable &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const preferredLocale = resolvePreferredLocale({
      pathname: externalPathname,
      localeCookie: request.cookies.get(LOCALE_COOKIE_NAME)?.value,
      acceptLanguage: request.headers.get('accept-language'),
    });
    if (preferredLocale !== DEFAULT_LOCALE) {
      const destination = new URL(
        `${localizePathname(externalPathname, preferredLocale)}${request.nextUrl.search}`,
        resolveSiteOrigin(),
      );
      return persistLocale(NextResponse.redirect(destination), request, preferredLocale);
    }
  }

  const locale =
    localeRoutesEnabled && localizedPath.hasLocalePrefix && localeRoutable
      ? localizedPath.locale
      : DEFAULT_LOCALE;
  const pathname = localeRoutable ? localizedPath.pathname : externalPathname;
  const isProtected = PROTECTED_PATTERNS.some((pattern) => pattern.test(pathname));
  const needsNonce = isProtected || pathname.startsWith('/auth');
  const nonce = needsNonce ? crypto.randomUUID().replaceAll('-', '') : null;
  const csp = nonce ? buildContentSecurityPolicy({ nonce, strict: true }) : null;
  const requestHeaders = new Headers(request.headers);
  if (nonce && csp) {
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
  }
  requestHeaders.set(LOCALE_HEADER_NAME, locale);
  requestHeaders.set(REQUEST_PATHNAME_HEADER_NAME, externalPathname);
  const secure = <T extends NextResponse>(response: T): T => {
    if (csp) response.headers.set('Content-Security-Policy', csp);
    response.headers.set('Content-Language', htmlLanguage(locale));
    return response;
  };
  const finish = (response: NextResponse) => {
    const routed = applicationResponse(request, requestHeaders, pathname, response);
    return secure(localizedPath.hasLocalePrefix ? persistLocale(routed, request, locale) : routed);
  };

  if (!hasSupabaseAuthCookie(request)) {
    return isProtected
      ? secure(loginRedirect(request, locale))
      : finish(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  // Public routes stay CDN-cheap even when a stale or attacker-supplied cookie
  // is present. Protected handlers repeat authorization before every mutation.
  if (!isProtected) {
    return finish(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const { response, user } = await updateSession(request, requestHeaders);

  if (!user) {
    return secure(redirectWithCookies(loginUrl(request, locale), response));
  }

  // Role, account status, and capabilities are resolved once through the
  // actor-bound get_auth_context RPC in the protected React tree.
  return finish(response);
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|.*\\..*).*)'],
};
