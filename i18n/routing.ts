import { defineRouting } from 'next-intl/routing';
import { APP_LOCALES, DEFAULT_LOCALE } from '@/i18n/config';

/**
 * Shared next-intl navigation contract. Public locale is encoded in the
 * physical URL, so its server/cache behavior must never consult a locale
 * cookie or Accept-Language. The client language menu owns its explicit
 * preference cookie solely as a convenience before navigating to that URL.
 */
export const routing = defineRouting({
  locales: APP_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeDetection: false,
  localeCookie: false,
});
