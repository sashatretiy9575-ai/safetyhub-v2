export const CONTENT_CACHE_TAG = 'content:v1';
export const ARTICLES_CACHE_TAG = 'content:articles:v1';
export const TOPICS_CACHE_TAG = 'content:topics:v1';

export const CONTENT_CACHE_REVALIDATE_SECONDS = 5 * 60;

export const CONTENT_REVALIDATE_PATHS = [
  '/',
  '/blog',
  '/topics',
  '/sitemap.xml',
  '/admin',
] as const;
