import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { PhoneCall } from '@phosphor-icons/react/dist/ssr/PhoneCall';
import { WhatsappLogo } from '@phosphor-icons/react/dist/ssr/WhatsappLogo';
import Link from 'next/link';
import { ACCOUNT_NAV_ITEMS, type AccountMode } from '@/components/layout/navigation-items';
import { HeaderNav } from '@/components/layout/header-nav';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { Logo } from '@/components/shared/logo';
import { ContactLink } from '@/components/shared/contact-link';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';
import { localizePathname } from '@/i18n/config';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';

const contactActionClass =
  'group relative inline-flex size-11 shrink-0 items-center justify-center transition-[color,background-color] duration-150';

const tooltipClass =
  'pointer-events-none absolute left-1/2 top-[calc(100%+0.625rem)] z-50 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--color-text)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-bg)] opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100';

export async function Header({
  accountMode,
  accountMenu,
  contacts,
}: {
  accountMode: AccountMode;
  accountMenu?: ReactNode;
  contacts: SiteContactSettings;
}) {
  const [locale, translations] = await Promise.all([getLocale(), getTranslations('Shell')]);
  const accountItem = ACCOUNT_NAV_ITEMS[accountMode];
  const localeRoutesEnabled = rolloutFeatureEnabled('localeRoutes');

  return (
    <header className="sticky top-0 z-40 bg-[var(--color-bg)]/96 pt-[var(--safe-area-top)] pr-[max(.5rem,var(--safe-area-right))] pb-2 pl-[max(.5rem,var(--safe-area-left))] backdrop-blur-xl min-[1120px]:pr-[max(1.5rem,var(--safe-area-right))] min-[1120px]:pb-0 min-[1120px]:pl-[max(1.5rem,var(--safe-area-left))] min-[1280px]:pr-[max(2rem,var(--safe-area-right))] min-[1280px]:pl-[max(2rem,var(--safe-area-left))]">
      <div className="glass-strong mx-auto flex h-[52px] w-full max-w-[1280px] items-center gap-2 rounded-[18px] px-3 min-[1120px]:h-16 min-[1120px]:gap-3 min-[1120px]:rounded-[var(--radius-group)] min-[1120px]:px-5">
        <Link
          href={localizePathname(ROUTES.home, locale)}
          prefetch={false}
          className="inline-flex min-h-11 shrink-0 items-center"
          aria-label={translations('homeAriaLabel')}
        >
          <Logo />
        </Link>

        <HeaderNav />

        <div className="flex-1" />

        {localeRoutesEnabled ? <LanguageSwitcher /> : null}

        <div className="hidden items-center gap-2 min-[1120px]:flex">
          <div
            role="group"
            aria-label={translations('quickContact')}
            className="glass flex h-11 items-center overflow-visible rounded-[var(--radius-group)]"
          >
            <ContactLink
              kind="phone"
              contacts={contacts}
              aria-label={translations('call', { phone: contacts.phoneDisplay })}
              aria-describedby="header-phone-tooltip"
              className={`${contactActionClass} rounded-l-[calc(var(--radius-group)-1px)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]`}
            >
              <PhoneCall size={20} weight="regular" aria-hidden="true" />
              <span id="header-phone-tooltip" role="tooltip" className={tooltipClass}>
                {translations('call', { phone: contacts.phoneDisplay })}
              </span>
            </ContactLink>
            <span aria-hidden="true" className="h-5 w-px bg-[var(--color-border)]" />
            <ContactLink
              kind="whatsapp"
              contacts={contacts}
              aria-label={translations('whatsapp')}
              aria-describedby="header-whatsapp-tooltip"
              className={`${contactActionClass} rounded-r-[calc(var(--radius-group)-1px)] text-[#247a4b] hover:bg-[var(--color-surface-muted)] dark:text-[#75cc96]`}
            >
              <WhatsappLogo size={21} weight="regular" aria-hidden="true" />
              <span id="header-whatsapp-tooltip" role="tooltip" className={tooltipClass}>
                {translations('whatsapp')}
              </span>
            </ContactLink>
          </div>

          <ThemeToggle />

          {accountMode === 'authenticated' ? (
            accountMenu
          ) : (
            <Button asChild variant="outline" size="sm" className="glass shadow-none">
              <Link href={localizePathname(accountItem.href, locale)} prefetch={false}>
                {translations(accountItem.messageKey)}
              </Link>
            </Button>
          )}
        </div>

        <div className="min-[1120px]:hidden">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
