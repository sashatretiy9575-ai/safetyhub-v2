import { Phone, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import { getTranslations } from 'next-intl/server';
import { ContactLink } from '@/components/shared/contact-link';
import { getSiteContacts } from '@/lib/site-contacts';

const contactClass =
  'flex min-h-14 items-center gap-3 px-1 py-3 transition-colors hover:text-[var(--color-primary)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]';

export async function LegalContacts() {
  const [contacts, t] = await Promise.all([
    getSiteContacts(),
    getTranslations('LegalFlow'),
  ]);
  return (
    <section
      id="legal-contacts"
      className="scroll-mt-24 space-y-3"
      aria-labelledby="legal-contacts-title"
    >
      <div>
        <h2 id="legal-contacts-title" className="text-xl font-semibold text-[var(--color-text)]">
          {t('contactsTitle')}
        </h2>
        <p className="mt-2 text-sm">
          {t('contactsDescription')}
        </p>
      </div>
      <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)] sm:grid sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <ContactLink kind="phone" contacts={contacts} className={contactClass}>
          <Phone
            size={22}
            weight="fill"
            className="shrink-0 text-[var(--color-primary)]"
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="block text-xs font-bold text-[var(--color-text-subtle)]">
              {t('phone')}
            </span>
            <span className="mt-1 block text-[15px] font-semibold text-[var(--color-text)]">
              {contacts.phoneDisplay}
            </span>
          </span>
        </ContactLink>
        <ContactLink kind="whatsapp" contacts={contacts} className={`${contactClass} sm:px-4`}>
          <WhatsappLogo
            size={23}
            weight="fill"
            className="shrink-0 text-[#16883e]"
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="block text-xs font-bold text-[var(--color-text-subtle)]">
              WhatsApp
            </span>
            <span className="mt-1 block text-[15px] font-semibold text-[var(--color-text)]">
              {t('write')}
            </span>
          </span>
        </ContactLink>
      </div>
    </section>
  );
}
