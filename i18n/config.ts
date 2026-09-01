export const APP_LOCALES = ['ru', 'kk', 'en', 'zh'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'ru';
export const BUSINESS_TIME_ZONE = 'Asia/Oral';
export const LOCALE_COOKIE_NAME = 'safetyhub-locale';
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
export const LOCALE_HEADER_NAME = 'x-safetyhub-locale';
export const REQUEST_PATHNAME_HEADER_NAME = 'x-safetyhub-pathname';

export const LOCALE_PREFIXES = ['kk', 'en', 'zh'] as const satisfies readonly Exclude<
  AppLocale,
  'ru'
>[];

export const HTML_LANGUAGE_BY_LOCALE = {
  ru: 'ru-KZ',
  kk: 'kk-KZ',
  en: 'en',
  zh: 'zh-Hans',
} as const satisfies Record<AppLocale, string>;

export const OPEN_GRAPH_LOCALE_BY_LOCALE = {
  ru: 'ru_KZ',
  kk: 'kk_KZ',
  en: 'en_US',
  zh: 'zh_CN',
} as const satisfies Record<AppLocale, string>;

const LANGUAGE_ALIASES = {
  ru: 'ru',
  kk: 'kk',
  kz: 'kk',
  en: 'en',
  zh: 'zh',
} as const satisfies Record<string, AppLocale>;

const NON_LOCALIZED_PREFIXES = [
  '/admin',
  '/api',
  '/_next',
  '/icons',
  '/images',
  '/fonts',
  '/screenshots',
  '/course-presentations',
  '/manifest',
  '/offline',
] as const;

const NON_LOCALIZED_PATHS = new Set([
  '/favicon.ico',
  '/manifest.json',
  '/offline.html',
  '/opengraph-image',
  '/robots.txt',
  '/sitemap.xml',
  '/sw.js',
]);

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return APP_LOCALES.includes(value as AppLocale);
}

function normalizePathname(pathname: string) {
  if (!pathname || pathname === '/') return '/';
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/');
}

export function splitLocalePathname(pathname: string): {
  locale: AppLocale;
  pathname: string;
  hasLocalePrefix: boolean;
} {
  const normalized = normalizePathname(pathname);
  const [, firstSegment = '', ...remainingSegments] = normalized.split('/');

  if (isAppLocale(firstSegment)) {
    const routePathname = remainingSegments.length > 0 ? `/${remainingSegments.join('/')}` : '/';
    return {
      locale: firstSegment,
      pathname: routePathname,
      hasLocalePrefix: true,
    };
  }

  return { locale: DEFAULT_LOCALE, pathname: normalized, hasLocalePrefix: false };
}

export function isLocaleRoutablePath(pathname: string) {
  const normalized = normalizePathname(pathname);
  if (NON_LOCALIZED_PATHS.has(normalized)) return false;
  if (/\.[a-z0-9]{1,10}$/iu.test(normalized)) return false;
  return !NON_LOCALIZED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function localizePathname(pathname: string, locale: AppLocale) {
  const routePathname = splitLocalePathname(pathname).pathname;
  if (!isLocaleRoutablePath(routePathname) || locale === DEFAULT_LOCALE) return routePathname;
  return routePathname === '/' ? `/${locale}` : `/${locale}${routePathname}`;
}

export function localeFromAcceptLanguage(value: string | null | undefined): AppLocale {
  if (!value) return DEFAULT_LOCALE;

  const candidates = value
    .split(',')
    .map((entry, index) => {
      const [languageRange = '', ...parameters] = entry.trim().split(';');
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const parsedQuality = qualityParameter
        ? Number.parseFloat(qualityParameter.trim().slice(2))
        : 1;
      return {
        languageRange: languageRange.toLowerCase(),
        quality: Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0,
        index,
      };
    })
    .filter(({ languageRange, quality }) => languageRange !== '*' && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { languageRange } of candidates) {
    const baseLanguage = languageRange.split('-')[0] ?? '';
    const locale = LANGUAGE_ALIASES[baseLanguage as keyof typeof LANGUAGE_ALIASES];
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}

export function resolvePreferredLocale(input: {
  pathname: string;
  localeCookie?: string | null;
  acceptLanguage?: string | null;
}) {
  const path = splitLocalePathname(input.pathname);
  if (path.hasLocalePrefix) return path.locale;
  if (isAppLocale(input.localeCookie)) return input.localeCookie;
  return localeFromAcceptLanguage(input.acceptLanguage);
}

export function htmlLanguage(locale: AppLocale) {
  return HTML_LANGUAGE_BY_LOCALE[locale];
}

export function openGraphLocale(locale: AppLocale) {
  return OPEN_GRAPH_LOCALE_BY_LOCALE[locale];
}

export function localeAlternates(pathname: string) {
  return {
    'ru-KZ': localizePathname(pathname, 'ru'),
    'kk-KZ': localizePathname(pathname, 'kk'),
    en: localizePathname(pathname, 'en'),
    'zh-Hans': localizePathname(pathname, 'zh'),
    'x-default': localizePathname(pathname, DEFAULT_LOCALE),
  } as const;
}
