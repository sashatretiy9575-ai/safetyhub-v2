import type { Metadata, Viewport } from 'next';
import { absoluteUrl } from '@/lib/utils';

/**
 * The PWA identity block, declared once.
 *
 * It was copied into four root layouts and the copies had already diverged:
 * two carried `apple-mobile-web-app-capable`, two did not, and only the public
 * ones declared a viewport at all — which is why `env(safe-area-inset-*)` did
 * nothing on the account and admin screens even though every component there
 * reads those variables.
 */
export const APP_VIEWPORT: Viewport = {
  themeColor: '#f7f8fa',
  colorScheme: 'light dark',
  // Without this the safe-area insets resolve to zero, and every rule written
  // against them — the mobile dock, the sticky header, the install banner — is
  // inert on a phone with a notch.
  viewportFit: 'cover',
};

/**
 * `manifest` is a URL rather than a locale, on purpose: `/manifest/[locale]`
 * answers 404 for anything but the default while locale routes are disabled,
 * and a broken manifest link makes "Add to Home Screen" produce a plain
 * bookmark instead of the installed app.
 */
export function pwaIdentity(manifestPath = '/manifest/ru'): Metadata {
  return {
    metadataBase: new URL(absoluteUrl('/')),
    manifest: manifestPath,
    icons: {
      icon: [
        { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
        { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
      apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black-translucent',
      title: 'SafetyHub',
    },
    other: { google: 'notranslate', 'apple-mobile-web-app-capable': 'yes' },
  };
}
