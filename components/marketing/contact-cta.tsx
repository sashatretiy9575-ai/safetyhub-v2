import { ContactActions } from '@/components/shared/contact-actions';
import { Container } from '@/components/ui/container';
import { getSiteContacts } from '@/lib/site-contacts';
import { getTranslations } from 'next-intl/server';

/**
 * One heading and the two contact tiles. The eyebrow repeated the menu item,
 * the sentence under the heading was the same one the contacts page used, and
 * the city and hours are printed by the footer directly below this block.
 */
export async function ContactCta() {
  const [contacts, t] = await Promise.all([getSiteContacts(), getTranslations('Home.contact')]);
  return (
    <section
      id="contacts"
      aria-labelledby="contacts-heading"
      className="bg-[var(--color-surface-muted)]/28 py-10 sm:py-14 lg:py-16"
    >
      <Container size="wide">
        <div className="rounded-[28px] border border-[var(--color-border)] bg-[var(--color-surface)]/76 p-5 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl sm:p-7 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.7fr)] lg:items-center lg:gap-x-12 lg:p-9">
          <h2
            id="contacts-heading"
            className="max-w-xl text-[24px] leading-[1.2] font-bold tracking-[-0.03em] text-balance sm:text-[30px] lg:text-[36px]"
          >
            {t('title')}
          </h2>

          <div className="mt-5 lg:mt-0">
            <ContactActions contacts={contacts} compact />
          </div>
        </div>
      </Container>
    </section>
  );
}
