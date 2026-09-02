import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Header } from '@/components/layout/header';
import { Footer } from '@/components/layout/footer';
import { DeferredBottomTabBar } from '@/components/layout/deferred-bottom-tab-bar';
import { getSiteContacts } from '@/lib/site-contacts';
import type { AppLocale } from '@/i18n/config';

export async function AppShell({
  children,
  authed = false,
  accountMode = authed ? 'authenticated' : 'guest',
  accountMenu,
  accountControl,
  localePathname,
  locale,
}: {
  children: ReactNode;
  authed?: boolean;
  accountMode?: 'authenticated' | 'guest' | 'neutral';
  accountMenu?: ReactNode;
  /** A client-only, non-authoritative control for static public shells. */
  accountControl?: ReactNode;
  /**
   * Private account layouts may already be dynamic for authentication. Public
   * layouts deliberately leave this undefined so Header never reads request
   * headers while rendering CDN-cacheable HTML.
   */
  localePathname?: string;
  /** Explicit only for dynamic account/auth shells rewritten by the proxy. */
  locale?: AppLocale;
}) {
  const [contacts, translations] = await Promise.all([
    getSiteContacts(),
    locale ? getTranslations({ locale, namespace: 'Shell' }) : getTranslations('Shell'),
  ]);
  return (
    <div className="flex min-h-dvh min-w-0 flex-col overflow-x-clip">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-[var(--radius-control)] focus:border focus:border-[var(--color-border-strong)] focus:bg-[var(--color-surface-elevated)] focus:px-4 focus:py-3 focus:font-semibold focus:text-[var(--color-text)] focus:shadow-[var(--shadow-pop)]"
      >
        {translations('skipToContent')}
      </a>
      <Header
        accountMode={accountMode}
        accountMenu={accountMenu}
        accountControl={accountControl}
        contacts={contacts}
        localePathname={localePathname}
        locale={locale}
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 pb-[var(--pwa-banner-space,0px)] transition-[padding] outline-none"
      >
        {children}
      </main>
      <div className="bg-[var(--color-footer)] pb-[var(--mobile-fixed-bottom-space)] min-[1120px]:pb-0">
        <Footer contacts={contacts} locale={locale} />
      </div>
      <DeferredBottomTabBar accountMode={accountMode} />
    </div>
  );
}
