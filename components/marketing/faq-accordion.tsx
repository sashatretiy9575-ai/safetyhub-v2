import { CaretDown, WhatsappLogo } from '@phosphor-icons/react/dist/ssr';
import { ContactLink } from '@/components/shared/contact-link';
import { Container } from '@/components/ui/container';
import { QUIZ_POLICY } from '@/lib/constants';
import { getSiteContacts } from '@/lib/site-contacts';
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
  headingLevel = 2,
}: {
  withHeader?: boolean;
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
              <p className="inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-[var(--color-text-subtle)] uppercase sm:text-xs">
                <span aria-hidden="true" className="h-px w-5 bg-[var(--color-primary)]" />
                FAQ
              </p>
              <Heading
                id="faq-heading"
                className="mt-2 text-[22px] leading-[1.22] font-bold tracking-[-0.025em] text-balance sm:text-[28px] lg:text-[36px]"
              >
                {t('title')}
              </Heading>
              <p className="mt-2.5 text-[14px] leading-[1.5] text-[var(--color-text-muted)] sm:text-[15px] sm:leading-6 lg:text-base">
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

            <ContactLink
              kind="whatsapp"
              contacts={contacts}
              className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-4 text-sm font-bold text-[var(--color-primary)] transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
            >
              <WhatsappLogo size={20} weight="fill" aria-hidden="true" />
              {t('other')}
            </ContactLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
