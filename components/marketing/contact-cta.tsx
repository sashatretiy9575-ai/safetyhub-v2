import { Clock, MapPin } from '@phosphor-icons/react/dist/ssr';
import { ContactActions } from '@/components/shared/contact-actions';
import { Container } from '@/components/ui/container';
import { CONTACT_DETAILS } from '@/lib/constants';
import { getSiteContacts } from '@/lib/site-contacts';
import { getTranslations } from 'next-intl/server';

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
          <div className="max-w-xl">
            <p className="inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-[var(--color-text-subtle)] uppercase sm:text-xs">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-[var(--color-primary)]"
              />
              {t('eyebrow')}
            </p>
            <h2
              id="contacts-heading"
              className="mt-2.5 text-[24px] leading-[1.2] font-bold tracking-[-0.03em] text-balance sm:text-[30px] lg:text-[36px]"
            >
              {t('title')}
            </h2>
            <p className="mt-2.5 text-[14px] leading-[1.5] text-[var(--color-text-muted)] sm:text-[15px] sm:leading-6">
              {t('description')}
            </p>
          </div>

          <div className="mt-5 lg:mt-0">
            <ContactActions contacts={contacts} compact />
          </div>

          <div className="mt-5 grid gap-x-5 border-t border-[var(--color-border)] pt-3 text-[13px] sm:grid-cols-2 lg:col-span-2 lg:text-sm">
            <div className="flex min-h-11 items-center gap-2.5 border-b border-[var(--color-border)] py-2 sm:border-b-0">
              <MapPin
                size={18}
                weight="duotone"
                className="shrink-0 text-[var(--color-primary)]"
                aria-hidden="true"
              />
              <span className="text-[15px]">{CONTACT_DETAILS.city}</span>
            </div>
            <div className="flex min-h-11 items-center gap-2.5 border-b border-[var(--color-border)] py-2 sm:border-b-0">
              <Clock
                size={18}
                weight="duotone"
                className="shrink-0 text-[var(--color-primary)]"
                aria-hidden="true"
              />
              <span className="text-[15px]">{CONTACT_DETAILS.hours}</span>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
