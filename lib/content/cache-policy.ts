import { APP_LOCALES, localizePathname } from '@/i18n/config';

export const CONTENT_CACHE_TAG = 'content:v1';
export const ARTICLES_CACHE_TAG = 'content:articles:v1';
export const TOPICS_CACHE_TAG = 'content:topics:v1';

export const CONTENT_CACHE_REVALIDATE_SECONDS = 5 * 60;

const CONTENT_ROOT_PATHS = [
  '/',
  '/blog',
  '/topics',
] as const;

/**
 * Every physical public locale route gets invalidated after publication. The
 * public roots are ISR pages, so tag invalidation handles data fetches while
 * these path receipts also invalidate HTML shells already resident at the CDN.
 */
export const CONTENT_REVALIDATE_PATHS = [
  ...CONTENT_ROOT_PATHS,
  ...APP_LOCALES.filter((locale) => locale !== 'ru').flatMap((locale) =>
    CONTENT_ROOT_PATHS.map((pathname) => localizePathname(pathname, locale)),
  ),
  '/sitemap.xml',
  '/admin',
] as const;

export function localizedContentPaths(pathname: string) {
  return APP_LOCALES.map((locale) => localizePathname(pathname, locale));
}
