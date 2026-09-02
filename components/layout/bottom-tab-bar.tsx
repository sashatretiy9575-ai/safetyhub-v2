'use client';

import { Article } from '@phosphor-icons/react/dist/ssr/Article';
import { BookOpen } from '@phosphor-icons/react/dist/ssr/BookOpen';
import { House } from '@phosphor-icons/react/dist/ssr/House';
import { Phone } from '@phosphor-icons/react/dist/ssr/Phone';
import { SignIn } from '@phosphor-icons/react/dist/ssr/SignIn';
import { User } from '@phosphor-icons/react/dist/ssr/User';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ACCOUNT_NAV_ITEMS, type AccountMode } from '@/components/layout/navigation-items';
import { useHydratedPathname } from '@/components/layout/use-hydrated-pathname';
import { ROUTES } from '@/lib/constants';
import { isRouteActive } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { localizePathname } from '@/i18n/config';

export function BottomTabBar({ accountMode }: { accountMode: AccountMode }) {
  const pathname = useHydratedPathname();
  const locale = useLocale();
  const translations = useTranslations('Shell');
  const accountItem = ACCOUNT_NAV_ITEMS[accountMode];
  const tabs = [
    {
      href: ROUTES.home,
      icon: <House size={21} weight="regular" />,
      label: translations('nav.home'),
    },
    {
      href: ROUTES.topics,
      icon: <BookOpen size={21} weight="regular" />,
      label: translations('nav.topics'),
    },
    {
      href: ROUTES.blog,
      icon: <Article size={21} weight="regular" />,
      label: translations('nav.blog'),
    },
    {
      href: ROUTES.contacts,
      icon: <Phone size={21} weight="regular" />,
      label: translations('nav.contacts'),
    },
    accountMode === 'guest'
      ? {
          ...accountItem,
          label: translations(accountItem.messageKey),
          icon: <SignIn size={21} weight="regular" />,
        }
      : {
          ...accountItem,
          label: translations(accountItem.messageKey),
          icon: <User size={21} weight="regular" />,
        },
  ];

  return (
    <nav
      aria-label={translations('mobileNavigation')}
      className="glass-strong fixed right-[max(.625rem,var(--safe-area-right))] bottom-[var(--safe-area-bottom)] left-[max(.625rem,var(--safe-area-left))] z-50 mx-auto h-[var(--mobile-tab-height)] max-w-[32.5rem] rounded-[var(--radius-dock)] p-0.5 min-[1024px]:hidden"
    >
      <div className="flex h-full items-stretch">
        {tabs.map(({ href, icon, label }) => {
          const localizedHref = localizePathname(href, locale);
          const isActive = pathname !== null && isRouteActive(pathname, localizedHref);
          return (
            <Link
              key={href}
              href={localizedHref}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[18px] px-0 py-1 text-[10.5px] leading-none font-semibold tracking-normal transition-[color,background-color] duration-150',
                isActive
                  ? 'bg-[var(--color-surface-muted)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
              )}
            >
              {isActive ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1 size-1 rounded-full bg-[var(--color-primary)]"
                />
              ) : null}
              <span className="flex h-7 items-center justify-center">{icon}</span>
              <span className="whitespace-nowrap">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
