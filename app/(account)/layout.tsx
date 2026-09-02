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
import { getProfileAvatarUrl } from '@/features/profile/server';
import { REQUEST_PATHNAME_HEADER_NAME } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';
import { absoluteUrl } from '@/lib/utils';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(absoluteUrl('/')),
  robots: { index: false, follow: false },
  other: { google: 'notranslate' },
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
  const avatarUrl = auth?.profile.avatar_updated_at
    ? await getProfileAvatarUrl(auth.user.id)
    : null;

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
