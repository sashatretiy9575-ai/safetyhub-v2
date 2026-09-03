import { Clock, MapPin, Phone, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Logo } from '@/components/shared/logo';
import { ContactLink } from '@/components/shared/contact-link';
import { Container } from '@/components/ui/container';
import { ROUTES } from '@/lib/constants';
import { localizePathname, type AppLocale } from '@/i18n/config';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';

const NAV_LINKS = [
  { href: ROUTES.topics, messageKey: 'nav.topics' },
  { href: ROUTES.blog, messageKey: 'nav.blog' },
  { href: ROUTES.contacts, messageKey: 'nav.contacts' },
  { href: ROUTES.faq, messageKey: 'nav.faq' },
] as const;

const LEGAL_LINKS = [
  { href: ROUTES.privacy, messageKey: 'footer.privacy' },
  { href: ROUTES.terms, messageKey: 'footer.terms' },
] as const;

export async function Footer({
  contacts,
  locale: explicitLocale,
}: {
  contacts: SiteContactSettings;
  locale?: AppLocale;
}) {
  const [requestLocale, translations] = await Promise.all([
    explicitLocale ? Promise.resolve(explicitLocale) : getLocale(),
    explicitLocale
      ? getTranslations({ locale: explicitLocale, namespace: 'Shell' })
      : getTranslations('Shell'),
  ]);
  const locale = requestLocale as AppLocale;
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10 bg-[var(--color-footer)] text-[var(--color-footer-foreground)]">
      <Container size="wide" className="py-7 md:py-10">
        <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-[1.15fr_.7fr_1fr] md:gap-10">
          <div className="max-w-md">
            <Logo inverse />
            <p className="mt-3 max-w-sm text-[15px] leading-6 text-white/68">
              {translations('footer.description')}
            </p>
            <ContactLink
              kind="whatsapp"
              contacts={contacts}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-primary)]/60 bg-[var(--color-primary)]/15 px-4 text-[15px] font-semibold text-white transition-[color,background-color,border-color] duration-150 hover:bg-[var(--color-primary)]/25 focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
            >
              <WhatsappLogo
                size={20}
                weight="regular"
                className="text-[var(--color-primary)]"
                aria-hidden="true"
              />
              {translations('whatsapp')}
            </ContactLink>
          </div>

          <nav aria-label={translations('footer.navigation')}>
            <h2 className="text-xs font-semibold tracking-[0.16em] text-white/45 uppercase">
              {translations('footer.sections')}
            </h2>
            <ul className="mt-3 grid grid-cols-2 gap-x-4 md:grid-cols-1">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={localizePathname(link.href, locale)}
                    prefetch={false}
                    className="inline-flex min-h-11 items-center text-sm font-semibold text-white/75 transition-colors duration-150 hover:text-white"
                  >
                    {translations(link.messageKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <h2 className="text-xs font-semibold tracking-[0.16em] text-white/45 uppercase">
              {translations('footer.contact')}
            </h2>
            <div className="mt-3 grid gap-1 text-[15px]">
              <ContactLink
                kind="phone"
                contacts={contacts}
                className="flex min-h-11 items-center gap-3 text-white/78 transition-colors duration-150 hover:text-white"
              >
                <Phone
                  size={19}
                  weight="regular"
                  className="shrink-0 text-white/50"
                  aria-hidden="true"
                />
                {contacts.phoneDisplay}
              </ContactLink>
              <div className="flex min-h-11 items-center gap-3 text-white/68">
                <MapPin
                  size={19}
                  weight="regular"
                  className="shrink-0 text-white/50"
                  aria-hidden="true"
                />
                {translations('footer.city')}
              </div>
              <div className="flex min-h-11 items-center gap-3 text-white/68">
                <Clock
                  size={19}
                  weight="regular"
                  className="shrink-0 text-white/50"
                  aria-hidden="true"
                />
                {/* This was text-xs while the phone and city rows next to it
                    inherit 15px, so the hours read as a footnote beside an
                    identically sized icon. */}
                <span>{translations('footer.hours')}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 border-t border-white/10 pt-4 text-xs text-white/70 md:mt-8">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
            <p>{translations('footer.copyright', { year })}</p>
            <nav
              aria-label={translations('footer.legalNavigation')}
              className="flex flex-wrap gap-x-5 gap-y-1"
            >
              {LEGAL_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={localizePathname(link.href, locale)}
                  prefetch={false}
                  className="inline-flex min-h-9 items-center text-white/70 transition-colors duration-150 hover:text-white"
                >
                  {translations(link.messageKey)}
                </Link>
              ))}
            </nav>
          </div>
          <p className="mt-1 flex min-h-11 flex-wrap items-center gap-x-1 sm:mt-0">
            <span>{translations('footer.development')}</span>
            <a
              href="https://rc-web.kz/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-[18px] font-extrabold text-[#ff8a24] transition-colors duration-150 hover:text-[#ffad66] sm:text-[20px]"
            >
              rc-web.kz
            </a>
          </p>
        </div>
      </Container>
    </footer>
  );
}
