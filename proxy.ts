import { NextResponse, type NextRequest } from 'next/server';
import {
  authRealmForLocale,
  DEFAULT_LOCALE,
  htmlLanguage,
  isLocaleRoutablePath,
  LOCALE_HEADER_NAME,
  localizePathname,
  REQUEST_PATHNAME_HEADER_NAME,
  splitLocalePathname,
  type AppLocale,
} from './i18n/config';
import { PROTECTED_PATTERNS } from './lib/constants';
import { buildContentSecurityPolicy } from './lib/security/content-security-policy';
import { rolloutFeatureEnabled } from './lib/release/rollout-flags';
import { resolveLegalDocumentVersion, type LegalDocumentType } from './lib/legal';
import { resolveSiteOrigin } from './lib/site-url';
import { clearSafetyHubLocalSession } from './lib/supabase/session-cleanup';
import { isSupabaseAuthCookieName } from './lib/supabase/auth-cookie-options';
import { authRealmForSessionUser, updateSession } from './lib/supabase/middleware';

function hasSupabaseAuthCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some((cookie) => isSupabaseAuthCookieName(cookie.name));
}

function loginUrl(request: NextRequest, locale: AppLocale) {
  const url = new URL('/auth/login', resolveSiteOrigin());
  url.pathname = localizePathname(url.pathname, locale);
  // A stale auth cookie on the login page itself must clear into a clean
  // login URL rather than producing `?return=/zh/auth/login` (or nesting the
  // same URL again on a later redirect). Only protected destinations need a
  // return target.
  if (request.nextUrl.pathname !== url.pathname) {
    url.searchParams.set('return', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  }
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

/**
 * These are the routes backed by physical `[locale]` segments. They never
 * need a header rewrite, so their Server Components can be statically
 * generated for every locale. Verification is intentionally included here
 * for correct document language, but excluded from CDN caching below because
 * it carries an unguessable personal certificate token.
 */
function isPhysicalLocaleRoute(pathname: string) {
  return (
    pathname === '/' ||
    pathname === '/topics' ||
    /^\/topics\/[^/]+$/u.test(pathname) ||
    pathname === '/blog' ||
    /^\/blog\/[^/]+$/u.test(pathname) ||
    pathname === '/contacts' ||
    pathname === '/faq' ||
    pathname === '/privacy' ||
    /^\/privacy\/[^/]+$/u.test(pathname) ||
    pathname === '/terms' ||
    /^\/terms\/[^/]+$/u.test(pathname) ||
    /^\/verify\/[^/]+$/u.test(pathname)
  );
}

function isCdnCacheablePublicRoute(pathname: string) {
  return isPhysicalLocaleRoute(pathname) && !pathname.startsWith('/verify/');
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
    // Physical locale route files exist in this build, unlike the historical
    // header rewrite. Keep the rollout fail-closed until the app/database
    // contract is explicitly enabled in a production-like environment.
    const disabled = request.nextUrl.clone();
    disabled.pathname = '/__locale-route-disabled';
    return NextResponse.rewrite(disabled);
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
    return NextResponse.redirect(destination);
  }

  // Query-string legal links were published before physical historical routes
  // existed. Redirect them before rendering so every legal HTML response is a
  // fixed immutable document and never a cookie/query-dependent CDN variant.
  // Unknown versions retain the prior 404 behavior instead of silently showing
  // the current document a person did not ask to reopen.
  const legacyLegalType: LegalDocumentType | null =
    localizedPath.pathname === '/privacy'
      ? 'privacy'
      : localizedPath.pathname === '/terms'
        ? 'terms'
        : null;
  if (
    legacyLegalType &&
    request.nextUrl.searchParams.has('version') &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const requestedVersion = request.nextUrl.searchParams.get('version') ?? undefined;
    const policy = resolveLegalDocumentVersion(legacyLegalType, requestedVersion);
    if (!policy) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }

    const destination = request.nextUrl.clone();
    destination.searchParams.delete('version');
    const targetLocale =
      localeRoutesEnabled && localizedPath.hasLocalePrefix && localeRoutable
        ? localizedPath.locale
        : DEFAULT_LOCALE;
    destination.pathname = localizePathname(
      `${localizedPath.pathname}/${encodeURIComponent(policy.version)}`,
      targetLocale,
    );
    const redirect = NextResponse.redirect(destination);
    redirect.headers.set('Cache-Control', 'private, no-store');
    return redirect;
  }

  const locale =
    localeRoutesEnabled && localizedPath.hasLocalePrefix && localeRoutable
      ? localizedPath.locale
      : DEFAULT_LOCALE;
  const pathname = localeRoutable ? localizedPath.pathname : externalPathname;
  const isProtected = PROTECTED_PATTERNS.some((pattern) => pattern.test(pathname));
  const isAuthEntry =
    pathname === '/callback' || pathname === '/auth' || pathname.startsWith('/auth/');
  const physicalLocaleRoute =
    localeRoutesEnabled && localizedPath.hasLocalePrefix && isPhysicalLocaleRoute(pathname);
  const cacheablePublicRoute =
    !isProtected &&
    !isAuthEntry &&
    isCdnCacheablePublicRoute(pathname) &&
    (request.method === 'GET' || request.method === 'HEAD');
  const needsNonce = isProtected || isAuthEntry;
  const nonce = needsNonce ? crypto.randomUUID().replaceAll('-', '') : null;
  const csp = nonce ? buildContentSecurityPolicy({ nonce, strict: true }) : null;
  const requestHeaders = new Headers(request.headers);
  if (nonce && csp) {
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
  }
  // Only private/auth-entry routes retain the legacy internal locale header.
  // Public locale pages resolve locale solely from their physical URL segment;
  // setting a request header there would make static HTML look request-bound.
  if (!physicalLocaleRoute && (isProtected || isAuthEntry)) {
    requestHeaders.set(LOCALE_HEADER_NAME, locale);
    requestHeaders.set(REQUEST_PATHNAME_HEADER_NAME, externalPathname);
  }
  const secure = <T extends NextResponse>(response: T): T => {
    if (csp) response.headers.set('Content-Security-Policy', csp);
    response.headers.set('Content-Language', htmlLanguage(locale));
    if (cacheablePublicRoute) {
      response.headers.set(
        'Cache-Control',
        'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
      );
    }
    return response;
  };
  const finish = (response: NextResponse) => {
    // Localized account/auth pages are deliberately still rewritten to the
    // existing private tree. Public pages are backed by physical locale route
    // segments and therefore preserve the external pathname all the way to
    // the renderer and its ISR cache key.
    const renderPathname = physicalLocaleRoute ? externalPathname : pathname;
    return secure(applicationResponse(request, requestHeaders, renderPathname, response));
  };

  if (!hasSupabaseAuthCookie(request)) {
    return isProtected
      ? secure(loginRedirect(request, locale))
      : finish(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  // Public routes stay CDN-cheap even when a stale or attacker-supplied cookie
  // is present.  Realm validation is intentionally limited to protected and
  // auth-entry paths: no public GET obtains an auth context or introduces a
  // user-cookie cache key.
  if (!isProtected && !isAuthEntry) {
    return finish(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const { response, user } = await updateSession(request, requestHeaders);

  if (!user) {
    return secure(
      clearSafetyHubLocalSession(request, redirectWithCookies(loginUrl(request, locale), response)),
    );
  }

  // A browser has exactly one Supabase cookie namespace.  Never let a valid
  // normal email-OTP session render a ZH-private/auth route (or the reverse)
  // merely because somebody manually typed a localized URL or a stale bundle
  // reused the old cookie.  The app-metadata hint is defense in depth only;
  // the private SQL realm assertion authorizes every locale-aware operation.
  if (authRealmForSessionUser(user) !== authRealmForLocale(locale)) {
    return secure(
      clearSafetyHubLocalSession(request, redirectWithCookies(loginUrl(request, locale), response)),
    );
  }

  // Role, account status, and capabilities are resolved once through the
  // actor-bound get_auth_context RPC in the protected React tree.
  return finish(response);
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|.*\\..*).*)'],
};
