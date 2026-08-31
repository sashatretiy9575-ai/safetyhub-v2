import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { isPreviewDeployment } from '@/lib/site-url';

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
        ],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
