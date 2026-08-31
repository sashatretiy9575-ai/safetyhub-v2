import { MapPin, Phone, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { Logo } from '@/components/shared/logo';
import { ContactLink } from '@/components/shared/contact-link';
import { Container } from '@/components/ui/container';
import { CONTACT_DETAILS, ROUTES } from '@/lib/constants';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';

const NAV_LINKS = [
  { href: ROUTES.topics, label: 'Курсы' },
  { href: ROUTES.blog, label: 'Блог' },
  { href: ROUTES.contacts, label: 'Контакты' },
  { href: ROUTES.faq, label: 'FAQ' },
] as const;

const LEGAL_LINKS = [
  { href: ROUTES.privacy, label: 'Конфиденциальность' },
  { href: ROUTES.terms, label: 'Условия использования' },
] as const;

export function Footer({ contacts }: { contacts: SiteContactSettings }) {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10 bg-[var(--color-footer)] text-[var(--color-footer-foreground)]">
      <Container size="wide" className="py-7 md:py-10">
        <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-[1.15fr_.7fr_1fr] md:gap-10">
          <div className="max-w-md">
            <Logo inverse />
            <p className="mt-3 max-w-sm text-[15px] leading-6 text-white/68">
              Практичное онлайн-обучение по охране труда, пожарной и промышленной безопасности для
              сотрудников и команд.
            </p>
            <ContactLink
              kind="whatsapp"
              contacts={contacts}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-white/15 bg-white/[0.05] px-4 text-[15px] font-semibold text-white shadow-[inset_0_1px_rgb(255_255_255_/_0.06)] transition-[color,background-color,border-color] duration-150 hover:border-[#67ca8e]/55 hover:bg-white/[0.08]"
            >
              <WhatsappLogo
                size={20}
                weight="regular"
                className="text-[#67ca8e]"
                aria-hidden="true"
              />
              Написать в WhatsApp
            </ContactLink>
          </div>

          <nav aria-label="Навигация в подвале">
            <h2 className="text-xs font-semibold tracking-[0.16em] text-white/45 uppercase">
              Разделы
            </h2>
            <ul className="mt-3 grid grid-cols-2 gap-x-4 md:grid-cols-1">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    prefetch={false}
                    className="inline-flex min-h-11 items-center text-sm font-semibold text-white/75 transition-colors duration-150 hover:text-white"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <h2 className="text-xs font-semibold tracking-[0.16em] text-white/45 uppercase">
              Связаться
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
                {CONTACT_DETAILS.city}
              </div>
              <p className="pl-8 text-xs leading-5 text-white/55">{CONTACT_DETAILS.hours}</p>
            </div>
          </div>
        </div>

        <div className="mt-6 border-t border-white/10 pt-4 text-xs text-white/50 md:mt-8">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
            <p>© {year} SafetyHub.kz. Все права защищены.</p>
            <nav aria-label="Юридическая информация" className="flex flex-wrap gap-x-5 gap-y-1">
              {LEGAL_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  prefetch={false}
                  className="inline-flex min-h-9 items-center text-white/45 transition-colors duration-150 hover:text-white/80"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <p className="mt-1 flex min-h-11 flex-wrap items-center gap-x-1 sm:mt-0">
            <span>Разработка сайта — </span>
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
