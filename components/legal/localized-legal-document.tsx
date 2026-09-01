import { getFormatter, getTranslations } from 'next-intl/server';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { LegalContacts } from '@/components/legal/legal-contacts';
import type { LocalizedLegalDocument } from '@/lib/content/legal-documents';

const externalLinkClass =
  'inline-flex min-h-11 items-center font-semibold text-[var(--color-primary)] underline underline-offset-2 hover:no-underline';

export async function LocalizedLegalDocumentView({
  document,
}: {
  document: LocalizedLegalDocument;
}) {
  const [format, t] = await Promise.all([getFormatter(), getTranslations('LegalFlow')]);
  const effectiveAt = format.dateTime(new Date(document.effectiveAt), {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

  return (
    <>
      <PageHeader
        title={document.title}
        eyebrow={t('documentsEyebrow')}
        variant="compact"
        className="[&_h1]:hyphens-auto"
      />
      <article
        className="py-10 md:py-14"
        data-legal-type={document.type}
        data-legal-version={document.version}
        data-legal-locale={document.locale}
        data-body-hash={document.bodyHash}
      >
        <Container
          size="content"
          className="max-w-[52rem] space-y-8 text-[15px] leading-7 text-[var(--color-text-muted)] md:text-base"
        >
          <header
            id="document-version"
            className="scroll-mt-24 space-y-3 border-y border-[var(--color-border)] py-5"
          >
            <p className="font-semibold text-[var(--color-text)]">
              {t('versionEffective', { version: document.version, date: effectiveAt })}
            </p>
          </header>

          {document.body.sections.map((section) =>
            section.id === 'legal-contacts' ? (
              <LegalContacts key={section.id} />
            ) : (
              <section
                key={section.id}
                className="space-y-3"
                aria-labelledby={`${section.id}-heading`}
              >
                <h2
                  id={`${section.id}-heading`}
                  className="text-xl font-semibold text-[var(--color-text)]"
                >
                  {section.heading}
                </h2>
                {section.paragraphs.map((paragraph, index) => (
                  <p key={`${section.id}-paragraph-${index}`}>{paragraph}</p>
                ))}
                {section.items.length > 0 ? (
                  <ul className="list-disc space-y-2 pl-5">
                    {section.items.map((item, index) => (
                      <li key={`${section.id}-item-${index}`}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {section.links.length > 0 ? (
                  <ul className="flex flex-wrap gap-x-5 gap-y-1" aria-label={t('references')}>
                    {section.links.map((link) => (
                      <li key={link.url}>
                        <a
                          className={externalLinkClass}
                          href={link.url}
                          target={link.url.startsWith('https://') ? '_blank' : undefined}
                          rel={link.url.startsWith('https://') ? 'noreferrer' : undefined}
                        >
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ),
          )}
        </Container>
      </article>
    </>
  );
}
