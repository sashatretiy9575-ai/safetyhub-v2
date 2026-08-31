import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { AppShell } from '@/components/layout/app-shell';
import { UserMenu } from '@/components/shared/user-menu';
import { CspNonceProvider } from '@/features/auth/csp-nonce';
import { getAuthContext } from '@/features/auth/server';
import { getProfileAvatarUrl } from '@/features/profile/server';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const [authState, requestHeaders] = await Promise.all([
    getAuthContext().then(
      (auth) => ({ auth, unavailable: false }),
      () => ({ auth: null, unavailable: true }),
    ),
    headers(),
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
    <CspNonceProvider nonce={nonce}>
      <AppShell
        authed={Boolean(auth)}
        accountMode={auth ? 'authenticated' : authState.unavailable ? 'neutral' : 'guest'}
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
    </CspNonceProvider>
  );
}
