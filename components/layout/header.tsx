import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { PhoneCall } from '@phosphor-icons/react/dist/ssr/PhoneCall';
import { WhatsappLogo } from '@phosphor-icons/react/dist/ssr/WhatsappLogo';
import Link from '@/components/shared/navigation-link';
import { AccountIconLink } from '@/components/layout/account-icon-link';
import { ACCOUNT_NAV_ITEMS, type AccountMode } from '@/components/layout/navigation-items';
import { HeaderNav } from '@/components/layout/header-nav';
import { headerTooltipClass } from '@/components/layout/header-tooltip';
import { DeferredLanguageSwitcher } from '@/components/layout/deferred-language-switcher';
import { Logo } from '@/components/shared/logo';
import { ContactLink } from '@/components/shared/contact-link';
import { DeferredThemeToggle } from '@/components/layout/deferred-theme-toggle';
import { ROUTES } from '@/lib/constants';
import { rolloutFeatureEnabled } from '@/lib/rollout-flags';
import { localesForLanguageSwitcher, localizePathname } from '@/i18n/config';
import type { AppLocale } from '@/i18n/config';
import type { SiteContactSettings } from '@/lib/site-contacts';

const contactActionClass =
  'group relative inline-flex size-11 shrink-0 items-center justify-center transition-[color,background-color] duration-150';

const tooltipClass = headerTooltipClass;

export async function Header({
  accountMode,
  accountMenu,
  accountControl,
  contacts,
  localePathname,
  locale: explicitLocale,
}: {
  accountMode: AccountMode;
  accountMenu?: ReactNode;
  accountControl?: ReactNode;
  contacts: SiteContactSettings;
  localePathname?: string;
  locale?: AppLocale;
}) {
  const [requestLocale, translations] = await Promise.all([
    explicitLocale ? Promise.resolve(explicitLocale) : getLocale(),
    explicitLocale
      ? getTranslations({ locale: explicitLocale, namespace: 'Shell' })
      : getTranslations('Shell'),
  ]);
  const locale = requestLocale as AppLocale;
  const accountItem = ACCOUNT_NAV_ITEMS[accountMode];
  const localeRoutesEnabled = rolloutFeatureEnabled('localeRoutes');
  const zhUsernamePasswordEnabled = rolloutFeatureEnabled('zhUsernamePassword');
  const switcherLocales = localesForLanguageSwitcher({
    pathname: localePathname ?? '/',
    localeRoutesEnabled,
    zhUsernamePasswordEnabled,
  });

  return (
    <header className="sticky top-0 z-40 bg-[var(--color-bg)]/96 pt-[var(--safe-area-top)] pr-[max(.5rem,var(--safe-area-right))] pb-2 pl-[max(.5rem,var(--safe-area-left))] backdrop-blur-xl lg:pr-[max(1.5rem,var(--safe-area-right))] lg:pb-0 lg:pl-[max(1.5rem,var(--safe-area-left))] xl:pr-[max(2rem,var(--safe-area-right))] xl:pl-[max(2rem,var(--safe-area-left))]">
      <div className="glass-strong mx-auto flex h-12 w-full max-w-[1280px] items-center gap-1.5 rounded-[18px] px-2 xs:h-[52px] xs:gap-2 xs:px-3 lg:h-16 lg:gap-3 lg:rounded-[var(--radius-group)] lg:px-5">
        <Link
          href={localizePathname(ROUTES.home, locale)}
          prefetch={false}
          className="inline-flex min-h-11 shrink-0 items-center"
          aria-label={translations('homeAriaLabel')}
        >
          <Logo />
        </Link>

        <HeaderNav locale={explicitLocale} />

        {/* One right-hand group rather than a flex spacer: the spacer cost a
            second flex gap, and at 320 px the header has no width to spare. */}
        <div className="ml-auto flex items-center gap-2 lg:gap-3">
          {switcherLocales.length > 1 ? (
            <DeferredLanguageSwitcher
              locales={switcherLocales}
              locale={locale}
              label={translations('language.label')}
              languageName={translations(`language.${locale}`)}
            />
          ) : null}

          <div className="flex items-center gap-1 lg:gap-2">
            <div
              role="group"
              aria-label={translations('quickContact')}
              className="hidden h-11 items-center overflow-visible lg:flex"
            >
              <ContactLink
                kind="phone"
                contacts={contacts}
                aria-label={translations('call', { phone: contacts.phoneDisplay })}
                aria-describedby="header-phone-tooltip"
                className={`${contactActionClass} rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]`}
              >
                <PhoneCall size={20} weight="regular" aria-hidden="true" />
                <span id="header-phone-tooltip" role="tooltip" className={tooltipClass}>
                  {translations('call', { phone: contacts.phoneDisplay })}
                </span>
              </ContactLink>
              <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-[var(--color-border)]" />
              <ContactLink
                kind="whatsapp"
                contacts={contacts}
                aria-label={translations('whatsapp')}
                aria-describedby="header-whatsapp-tooltip"
                className={`${contactActionClass} rounded-[var(--radius-control)] text-[var(--color-primary)] hover:bg-[var(--color-surface-muted)]`}
              >
                <WhatsappLogo size={21} weight="regular" aria-hidden="true" />
                <span id="header-whatsapp-tooltip" role="tooltip" className={tooltipClass}>
                  {translations('whatsapp')}
                </span>
              </ContactLink>
            </div>

            <DeferredThemeToggle />

            {/* One round, avatar-sized account slot at every width: a guest sees
                the account icon, a signed-in visitor the avatar menu in the same
                place. Below 1024 px the header used to show a text button for
                guests and nothing at all once signed in. */}
            {accountMode === 'authenticated' ? (
              accountMenu
            ) : (
              (accountControl ?? (
                <AccountIconLink
                  href={localizePathname(accountItem.href, locale)}
                  label={translations(accountItem.messageKey)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
