import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { isPreviewDeployment } from '@/lib/site-url';
import { LOCALE_PREFIXES } from '@/i18n/config';

/**
 * Only what crawlers must not even request. The sign-in, profile, onboarding
 * and test screens are left crawlable on purpose: they answer with noindex, and
 * a robots.txt block hid that answer — every public page links to the sign-in
 * screen, so it could be listed as a bare URL that Google was never allowed to
 * open and see was not meant to be indexed.
 */
const PRIVATE_PATHS = ['/callback'] as const;

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
