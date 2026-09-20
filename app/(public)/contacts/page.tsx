import { Clock, MapPin } from '@phosphor-icons/react/dist/ssr';
import { getLocale, getTranslations } from 'next-intl/server';
import { ContactActions } from '@/components/shared/contact-actions';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { getSiteContacts } from '@/server/site-contacts';
import { buildMetadata } from '@/lib/seo';

export async function generateMetadata() {
  const t = await getTranslations('Contacts');
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription'),
    path: '/contacts',
    locale: await getLocale(),
  });
}

export default async function ContactsPage() {
  const [contacts, t, shellT] = await Promise.all([
    getSiteContacts(),
    getTranslations('Contacts'),
    getTranslations('Shell.footer'),
  ]);
  return (
    <>
      {/* The heading is the whole introduction: the eyebrow repeated the menu
          item and the sentence under it was the same one the home page used. */}
      <PageHeader title={t('title')} variant="contact" />

      <section aria-label={t('title')} className="py-8 sm:py-11 lg:py-14">
        <Container size="wide">
          <div className="max-w-xl">
            <ContactActions contacts={contacts} />

            {/* Where we are and when we answer is one sentence. It used to be a
                framed panel of two labelled cells split by a rule, which asked
                the reader to parse a table for two short facts. */}
            <p className="text-body-sm mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-text-muted)]">
              <MapPin aria-hidden="true" className="size-4 shrink-0" />
              <a
                href="https://www.google.com/maps/search/?api=1&query=Almaty%2C%20Kazakhstan"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 transition-colors hover:text-[var(--color-primary)]"
              >
                {shellT('city')}
              </a>
              <span aria-hidden="true">·</span>
              <Clock aria-hidden="true" className="size-4 shrink-0" />
              {shellT('hours')}
            </p>
          </div>
        </Container>
      </section>
    </>
  );
}
