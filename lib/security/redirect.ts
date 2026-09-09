import { splitLocalePathname, type AppLocale } from '@/i18n/config';

/**
 * Normalizes a caller-supplied redirect target to a same-origin path.
 *
 * The module is deliberately isomorphic: the login flow validates `?return=`
 * in the browser, while server routes reuse the same rules. Rejecting a value
 * that contains a backslash matters more than it looks — browsers normalize
 * `\` to `/`, so `/\evil.com` passes a naive `startsWith('/')` check and then
 * navigates off-origin.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/profile') {
  if (!value || !value.startsWith('/') || value.includes('\\')) return fallback;
  try {
    const base = new URL('https://safetyhub.local');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * Destinations a `?return=` parameter may point at, written without a locale
 * prefix. `proxy.ts` only builds the parameter for `PROTECTED_PATTERNS`, so
 * this list is what those protected routes can legitimately resolve back to.
 */
const RETURN_PREFIXES = ['/topics', '/profile', '/onboarding'] as const;

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Answers whether a `?return=` value may be honoured for a landing page the
 * server already authorized. `landing` keeps the decision anchored to the
 * account the session actually has: an administrator returns into `/admin`,
 * everyone else into the learner area.
 */
export function safeReturnPath(
  value: string | null | undefined,
  landing: 'admin' | 'account',
): string | null {
  const candidate = safeRedirectPath(value, '');
  if (!candidate) return null;
  const { pathname } = splitLocalePathname(candidate);
  if (landing === 'admin') return matchesPrefix(pathname, '/admin') ? candidate : null;
  return RETURN_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix)) ? candidate : null;
}

export type { AppLocale };
