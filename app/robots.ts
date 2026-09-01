import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { isPreviewDeployment } from '@/lib/site-url';
import { LOCALE_PREFIXES } from '@/i18n/config';

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
          '/profile',
          '/auth/*',
          '/callback',
          '/topics/*/test',
          ...LOCALE_PREFIXES.flatMap((locale) => [
            `/${locale}/profile`,
            `/${locale}/auth/*`,
            `/${locale}/callback`,
            `/${locale}/onboarding`,
            `/${locale}/topics/*/test`,
          ]),
        ],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
