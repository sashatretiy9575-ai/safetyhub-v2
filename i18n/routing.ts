import { defineRouting } from 'next-intl/routing';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
} from '@/i18n/config';

/**
 * Shared next-intl contract. The application keeps its existing route tree;
 * proxy.ts applies the equivalent `as-needed` external URL policy before the
 * App Router resolves a page.
 */
export const routing = defineRouting({
  locales: APP_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeDetection: true,
  localeCookie: {
    name: LOCALE_COOKIE_NAME,
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
  },
});
