import { headers } from 'next/headers';
import { DEFAULT_LOCALE, isAppLocale, LOCALE_HEADER_NAME, type AppLocale } from '@/i18n/config';

/**
 * Resolves the locale injected by the proxy for dynamic account/auth routes.
 *
 * Public pages intentionally must not read request headers: their physical
 * locale segment keeps them eligible for CDN/ISR caching. Account pages are
 * already private, dynamic renders, so they use the trusted proxy header to
 * keep a rewritten `/zh/...` route in the Chinese auth realm.
 */
export async function getPrivateRequestLocale(): Promise<AppLocale> {
  const candidate = (await headers()).get(LOCALE_HEADER_NAME);
  return isAppLocale(candidate) ? candidate : DEFAULT_LOCALE;
}
