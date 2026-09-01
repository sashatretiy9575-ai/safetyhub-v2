import type { MetadataRoute } from 'next';
import { APP_LOCALES, htmlLanguage, isAppLocale, localizePathname } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

export const dynamicParams = false;

export function generateStaticParams() {
  return APP_LOCALES.map((locale) => ({ locale }));
}

export async function GET(_request: Request, context: { params: Promise<{ locale: string }> }) {
  const { locale: candidate } = await context.params;
  if (!isAppLocale(candidate)) return new Response('Not found', { status: 404 });
  if (candidate !== DEFAULT_LOCALE && !rolloutFeatureEnabled('localeRoutes')) {
    return new Response('Not found', { status: 404 });
  }

  const messages = await loadMessages(candidate);
  const metadata = messages.Metadata as Record<string, string>;
  const shell = messages.Shell as {
    nav: Record<'topics' | 'blog', string>;
    account: Record<'authenticated', string>;
  };
  const manifest: MetadataRoute.Manifest = {
    id: localizePathname('/', candidate),
    name: metadata.manifestName,
    short_name: 'SafetyHub',
    description: metadata.manifestDescription,
    lang: htmlLanguage(candidate),
    dir: 'ltr',
    start_url: localizePathname('/', candidate),
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    background_color: '#f7f8fa',
    theme_color: '#f7f8fa',
    categories: ['education', 'business'],
    icons: [
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    screenshots: [
      {
        src: '/screenshots/safetyhub-mobile.png',
        sizes: '390x844',
        type: 'image/png',
        form_factor: 'narrow',
        label: metadata.screenshotMobile,
      },
      {
        src: '/screenshots/safetyhub-wide.png',
        sizes: '1280x720',
        type: 'image/png',
        form_factor: 'wide',
        label: metadata.screenshotWide,
      },
    ],
    shortcuts: [
      {
        name: shell.nav.topics,
        short_name: shell.nav.topics,
        url: localizePathname('/topics', candidate),
        icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192' }],
      },
      {
        name: shell.nav.blog,
        short_name: shell.nav.blog,
        url: localizePathname('/blog', candidate),
        icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192' }],
      },
      {
        name: shell.account.authenticated,
        short_name: shell.account.authenticated,
        url: localizePathname('/profile', candidate),
        icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192' }],
      },
    ],
  };

  return Response.json(manifest, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
      'Content-Type': 'application/manifest+json; charset=utf-8',
      Vary: 'Accept-Encoding',
    },
  });
}
