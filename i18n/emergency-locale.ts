import { isAppLocale, splitLocalePathname, type AppLocale } from '@/i18n/config';

/**
 * The locale for screens that render before — or instead of — a locale provider.
 *
 * The root `not-found`, the root `error` boundary and `global-error` all run
 * outside the layouts that call `setRequestLocale`, so there is no request
 * locale to read. The URL is the strongest signal available on the client, and
 * the cookie the language switcher writes is the fallback for the unprefixed
 * Russian root. On the server this is only ever the first render, so it answers
 * with the default rather than guessing.
 */
export function emergencyLocale(): AppLocale {
  if (typeof window === 'undefined') return 'ru';
  const fromPathname = splitLocalePathname(window.location.pathname);
  if (fromPathname.hasLocalePrefix) return fromPathname.locale;
  const fromCookie = document.cookie
    .split(';')
    .map((entry) => entry.trim().split('='))
    .find(([name]) => name === 'safetyhub-locale')?.[1];
  return isAppLocale(fromCookie) ? fromCookie : 'ru';
}
