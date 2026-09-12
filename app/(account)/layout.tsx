import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/layout/app-shell';
import { RootDocument } from '@/components/layout/root-document';
import { PWAProvider } from '@/components/shared/pwa-provider';
import { UserMenu } from '@/components/shared/user-menu';
import { CspNonceProvider } from '@/components/auth/csp-nonce';
import { getAuthContext } from '@/server/auth/session';
import { pickClientNamespaces } from '@/i18n/client-namespaces';
import { REQUEST_PATHNAME_HEADER_NAME } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';
import { APP_VIEWPORT, pwaIdentity } from '@/lib/pwa/identity';
import '../globals.css';

// The install block lives on /profile, so this group must carry the full PWA
// identity too: without a manifest link here, iOS "Add to Home Screen" from
// the profile page created a plain Safari bookmark instead of the app.
// Without this the safe-area insets are zero on these screens, and the
// mobile dock, the sticky header and the install banner all lose the
// spacing they were written against.
export const viewport: Viewport = APP_VIEWPORT;

export const metadata: Metadata = {
  title: 'SafetyHub',
  robots: { index: false, follow: false },
  ...pwaIdentity(),
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
    <RootDocument locale={locale} messages={pickClientNamespaces(messages)}>
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
