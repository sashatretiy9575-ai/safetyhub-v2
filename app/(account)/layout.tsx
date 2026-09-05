import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/layout/app-shell';
import { RootDocument } from '@/components/layout/root-document';
import { PWAProvider } from '@/components/shared/pwa-provider';
import { UserMenu } from '@/components/shared/user-menu';
import { CspNonceProvider } from '@/features/auth/csp-nonce';
import { getAuthContext } from '@/features/auth/server';
import { REQUEST_PATHNAME_HEADER_NAME } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';
import { absoluteUrl } from '@/lib/utils';
import '../globals.css';

// The install block lives on /profile, so this group must carry the full PWA
// identity too: without a manifest link here, iOS "Add to Home Screen" from
// the profile page created a plain Safari bookmark instead of the app.
export const metadata: Metadata = {
  title: 'SafetyHub',
  metadataBase: new URL(absoluteUrl('/')),
  robots: { index: false, follow: false },
  manifest: '/manifest/ru',
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

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const [requestHeaders, locale] = await Promise.all([headers(), getPrivateRequestLocale()]);
  setRequestLocale(locale);
  const [authState, messages] = await Promise.all([
    getAuthContext().then(
      (auth) => ({ auth, unavailable: false }),
      () => ({ auth: null, unavailable: true }),
    ),
    loadMessages(locale),
  ]);
  const { auth } = authState;
  const nonce = requestHeaders.get('x-nonce') ?? undefined;
  const fullName = auth
    ? `${auth.profile.name ?? ''} ${auth.profile.surname ?? ''}`.trim() || undefined
    : undefined;
  // Same-origin address instead of a server-resolved signed URL: the shell no
  // longer waits on a manifest RPC and a Storage call to paint.
  const avatarUrl = auth?.profile.avatar_updated_at ? '/api/profile/avatar' : null;

  return (
    <RootDocument locale={locale} messages={messages}>
      <CspNonceProvider nonce={nonce}>
        <PWAProvider>
          <AppShell
            authed={Boolean(auth)}
            accountMode={auth ? 'authenticated' : authState.unavailable ? 'neutral' : 'guest'}
            localePathname={requestHeaders.get(REQUEST_PATHNAME_HEADER_NAME) ?? '/'}
            locale={locale}
            accountMenu={
              auth ? (
                <UserMenu
                  email={auth.user.email ?? ''}
                  fullName={fullName}
                  isAdmin={auth.role === 'admin'}
                  avatarUrl={avatarUrl}
                />
              ) : null
            }
          >
            {children}
          </AppShell>
        </PWAProvider>
      </CspNonceProvider>
    </RootDocument>
  );
}
