import type { AppLocale } from './config';

/**
 * The locale handed to `Intl` for dates, which is not always the document
 * language. English pages are written in British English for readers in
 * Kazakhstan, but plain `en` formats the American way: «September 26 at
 * 06:00 PM» and «9/26/2026». `en-GB` gives «26 September at 18:00» and
 * «26/09/2026». The other three match `HTML_LANGUAGE_BY_LOCALE`.
 */
export const INTL_LOCALE_BY_LOCALE = {
  ru: 'ru-KZ',
  kk: 'kk-KZ',
  en: 'en-GB',
  zh: 'zh-Hans',
} as const satisfies Record<AppLocale, string>;

export function intlLocale(locale: AppLocale) {
  return INTL_LOCALE_BY_LOCALE[locale];
}
