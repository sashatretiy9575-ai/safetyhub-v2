'use client';

import { Article } from '@phosphor-icons/react/dist/ssr/Article';
import { BookOpen } from '@phosphor-icons/react/dist/ssr/BookOpen';
import { House } from '@phosphor-icons/react/dist/ssr/House';
import { Phone } from '@phosphor-icons/react/dist/ssr/Phone';
import { SignIn } from '@phosphor-icons/react/dist/ssr/SignIn';
import { User } from '@phosphor-icons/react/dist/ssr/User';
import { useLocale, useTranslations } from 'next-intl';
import { DockItem } from '@/components/layout/dock-item';
import { ACCOUNT_NAV_ITEMS, type AccountMode } from '@/components/layout/navigation-items';
import { useHydratedPathname } from '@/components/layout/use-hydrated-pathname';
import { ROUTES } from '@/lib/constants';
import { isRouteActive } from '@/lib/navigation';
import { localizePathname, splitLocalePathname } from '@/i18n/config';

export function BottomTabBar({ accountMode }: { accountMode: AccountMode }) {
  const pathname = useHydratedPathname();
  const routePathname = splitLocalePathname(pathname ?? '/').pathname;
  const locale = useLocale();
  const translations = useTranslations('Shell');
  const accountItem = ACCOUNT_NAV_ITEMS[accountMode];
  const tabs = [
    { href: ROUTES.home, Icon: House, label: translations('nav.home') },
    { href: ROUTES.topics, Icon: BookOpen, label: translations('nav.topics') },
    { href: ROUTES.blog, Icon: Article, label: translations('nav.blog') },
    { href: ROUTES.contacts, Icon: Phone, label: translations('nav.contacts') },
    accountMode === 'guest'
      ? { ...accountItem, label: translations(accountItem.messageKey), Icon: SignIn }
      : { ...accountItem, label: translations(accountItem.messageKey), Icon: User },
  ];

  return (
    <nav
      aria-label={translations('mobileNavigation')}
      className="glass-strong fixed right-[max(.625rem,var(--safe-area-right))] bottom-[var(--safe-area-bottom)] left-[max(.625rem,var(--safe-area-left))] z-50 mx-auto h-[var(--mobile-tab-height)] max-w-[32.5rem] rounded-[var(--radius-dock)] p-0.5 lg:hidden"
    >
      <div className="flex h-full items-stretch">
        {tabs.map(({ href, Icon, label }) => {
          const localizedHref = localizePathname(href, locale);
          // Compare without the language prefix. `/kk` is the localized home, so
          // matching the raw paths made `current.startsWith('/kk/')` true on every
          // Kazakh, English and Chinese page and lit the Home tab alongside the
          // real one. Russian has no prefix, which is why it never showed there.
          const isActive = pathname !== null && isRouteActive(routePathname, href);
          // The item itself — sizes, the dot, the active tint — lives in DockItem,
          // which the admin dock renders too.
          return (
            <DockItem key={href} href={localizedHref} label={label} active={isActive}>
              <Icon size={21} weight="regular" />
            </DockItem>
          );
        })}
      </div>
    </nav>
  );
}
