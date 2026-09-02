import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { PRIMARY_NAV_ITEMS } from '@/components/layout/navigation-items';
import { localizePathname, type AppLocale } from '@/i18n/config';

/**
 * The primary public navigation has no client-only state requirement. Keeping
 * it server-rendered removes pathname/router hooks from every public initial
 * bundle; the current-page marker is a visual enhancement, not navigation
 * state, so links remain fully usable without it.
 */
export async function HeaderNav({ locale: explicitLocale }: { locale?: AppLocale }) {
  const [requestLocale, translations] = await Promise.all([
    explicitLocale ? Promise.resolve(explicitLocale) : getLocale(),
    explicitLocale
      ? getTranslations({ locale: explicitLocale, namespace: 'Shell' })
      : getTranslations('Shell'),
  ]);
  const locale = requestLocale as AppLocale;

  return (
    <nav
      className="ml-3 hidden h-full items-stretch gap-0.5 min-[1024px]:flex"
      aria-label={translations('primaryNavigation')}
    >
      {PRIMARY_NAV_ITEMS.map((item) => {
        const href = localizePathname(item.href, locale);
        return (
          <Link
            key={item.href}
            href={href}
            className="relative inline-flex h-full min-w-11 items-center px-2.5 text-sm font-semibold text-[var(--color-text-muted)] transition-colors duration-150 hover:text-[var(--color-text)]"
          >
            {translations(item.messageKey)}
          </Link>
        );
      })}
    </nav>
  );
}
