import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { isPreviewDeployment } from '@/lib/site-url';
import { LOCALE_PREFIXES } from '@/i18n/config';

/**
 * The private screens, listed once.
 *
 * The prefixed and unprefixed lists were written out separately and had already
 * drifted: `/onboarding` was disallowed under `/kk`, `/en` and `/zh` and left
 * open on the route that actually exists today.
 */
const PRIVATE_PATHS = [
  '/profile',
  '/onboarding',
  '/auth/*',
  '/callback',
  '/topics/*/test',
] as const;

export default function robots(): MetadataRoute.Robots {
  if (isPreviewDeployment()) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/admin',
          '/admin/*',
          ...PRIVATE_PATHS,
          ...LOCALE_PREFIXES.flatMap((locale) =>
            PRIVATE_PATHS.map((pathname) => `/${locale}${pathname}`),
          ),
        ],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
