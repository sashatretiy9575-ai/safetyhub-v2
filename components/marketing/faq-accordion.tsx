import { CaretDown, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import { ContactLink } from '@/components/shared/contact-link';
import { Container } from '@/components/ui/container';
import { QUIZ_POLICY } from '@/lib/constants';
import { getSiteContacts } from '@/server/site-contacts';
import { getTranslations } from 'next-intl/server';

export async function getFaqData() {
  const t = await getTranslations('Faq');
  return [
    { question: t('phoneQuestion'), answer: t('phoneAnswer') },
    { question: t('countQuestion'), answer: t('countAnswer', QUIZ_POLICY) },
    { question: t('resultQuestion'), answer: t('resultAnswer') },
  ] as const;
}

export async function FaqAccordion({
  withHeader = true,
  withContact = true,
  headingLevel = 2,
}: {
  withHeader?: boolean;
  /** The home page renders the contact block right below, so it hides this link. */
  withContact?: boolean;
  headingLevel?: 1 | 2;
}) {
  const [contacts, t, faqData] = await Promise.all([
    getSiteContacts(),
    getTranslations('Faq'),
    getFaqData(),
  ]);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';

  return (
    <section
      id="faq"
      aria-labelledby={withHeader ? 'faq-heading' : undefined}
      aria-label={withHeader ? undefined : t('title')}
      className="py-10 [contain-intrinsic-size:auto_520px] [content-visibility:auto] sm:py-14 lg:py-16"
    >
      <Container size="wide">
        <div
          className={
            withHeader
              ? 'grid gap-7 lg:grid-cols-[minmax(17rem,0.62fr)_minmax(0,1.38fr)] lg:gap-14'
              : ''
          }
        >
          {withHeader ? (
            <div className="max-w-xl lg:pt-2">
              <Heading id="faq-heading" className="text-h2 font-bold text-balance">
                {t('title')}
              </Heading>
              <p className="text-body-sm mt-2.5 text-[var(--color-text-muted)] lg:text-base">
                {t('description')}
              </p>
            </div>
          ) : null}

          <div className={withHeader ? 'min-w-0' : 'ml-auto w-full max-w-[780px]'}>
            <div className="space-y-3">
              {faqData.map((item) => (
                <details
                  key={item.question}
                  className="group overflow-hidden rounded-[20px] border border-[var(--color-border)] bg-[var(--color-surface)]/72 shadow-[var(--shadow-soft)] backdrop-blur-xl open:border-[var(--color-border-strong)]"
                >
                  <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-left font-bold marker:content-none md:px-5 [&::-webkit-details-marker]:hidden">
                    <span>{item.question}</span>
                    <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] text-[var(--color-primary)] transition-transform group-open:rotate-180">
                      <CaretDown size={19} weight="bold" aria-hidden="true" />
                    </span>
                  </summary>
                  <p className="border-t border-[var(--color-border)] px-4 py-4 text-sm leading-relaxed text-[var(--color-text-muted)] md:px-5">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>

            {/* The home page places the contact block right under this
                section, so a WhatsApp link here duplicated it; /faq keeps it. */}
            {withContact ? (
              <ContactLink
                kind="whatsapp"
                contacts={contacts}
                className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-4 text-sm font-bold text-[var(--color-primary)] transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
              >
                <WhatsappLogo size={20} weight="fill" aria-hidden="true" />
                {t('other')}
              </ContactLink>
            ) : null}
          </div>
        </div>
      </Container>
    </section>
  );
}
