import type { ReactNode } from 'react';
import { Header } from '@/components/layout/header';
import { Footer } from '@/components/layout/footer';
import { BottomTabBar } from '@/components/layout/bottom-tab-bar';
import { getSiteContacts } from '@/lib/site-contacts';

export async function AppShell({
  children,
  authed = false,
  accountMode = authed ? 'authenticated' : 'guest',
  accountMenu,
}: {
  children: ReactNode;
  authed?: boolean;
  accountMode?: 'authenticated' | 'guest' | 'neutral';
  accountMenu?: ReactNode;
}) {
  const contacts = await getSiteContacts();
  return (
    <div className="flex min-h-dvh min-w-0 flex-col overflow-x-clip">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-[var(--radius-control)] focus:border focus:border-[var(--color-border-strong)] focus:bg-[var(--color-surface-elevated)] focus:px-4 focus:py-3 focus:font-semibold focus:text-[var(--color-text)] focus:shadow-[var(--shadow-pop)]"
      >
        Перейти к основному содержимому
      </a>
      <Header accountMode={accountMode} accountMenu={accountMenu} contacts={contacts} />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 pb-[var(--pwa-banner-space,0px)] outline-none transition-[padding]"
      >
        {children}
      </main>
      <div className="bg-[var(--color-footer)] pb-[var(--mobile-fixed-bottom-space)] min-[1120px]:pb-0">
        <Footer contacts={contacts} />
      </div>
      <BottomTabBar accountMode={accountMode} />
    </div>
  );
}
