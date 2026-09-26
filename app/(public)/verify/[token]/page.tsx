export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { CheckCircle, XCircle } from '@phosphor-icons/react/dist/ssr';
import {
  getPublicCertificateVerification,
  type PublicCertificateVerification,
} from '@/server/certificates/issuance';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';
import { getLocale, getTranslations } from 'next-intl/server';
import { BUSINESS_TIME_ZONE, htmlLanguage } from '@/i18n/config';
import { absoluteUrl } from '@/lib/utils';

/**
 * The date printed on the document — its sitting, a day in Oral — rather than
 * the moment of issue in the server's zone, which ran a day behind for anything
 * issued after 19:00 UTC. Noon +05:00 keeps the day whatever zone formats it.
 */
function printedDate(certificate: PublicCertificateVerification, language: string) {
  const instant = certificate.documentDate
    ? new Date(`${certificate.documentDate}T12:00:00+05:00`)
    : new Date(certificate.issuedAt);
  return instant.toLocaleDateString(language, { timeZone: BUSINESS_TIME_ZONE });
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Certificate');
  const title = t('verifyMetadataTitle');
  const description = t('verifyMetadataDescription');
  return {
    metadataBase: new URL(absoluteUrl('/')),
    title,
    description,
    // This link is sent to an employer in a messenger, so it needs a preview —
    // and the preview has to stay impersonal: the generic card, never anything
    // from the certificate itself.
    openGraph: {
      type: 'website',
      siteName: 'SafetyHub.kz',
      title,
      description,
      images: [{ url: absoluteUrl('/opengraph-image'), width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [absoluteUrl('/opengraph-image')],
    },
    robots: { index: false, follow: false },
    // The parent layout's canonical would otherwise apply here, pointing a
    // per-certificate page at «/» and putting it in the home page's hreflang
    // cluster. A self-canonical is not an option either: the token would then
    // be published in the markup.
    alternates: { canonical: null },
  };
}

export default async function VerifyCertificatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [certificate, t, locale] = await Promise.all([
    getPublicCertificateVerification(token),
    getTranslations('Certificate'),
    getLocale(),
  ]);
  if (!certificate) {
    return (
      <section className="py-12 md:py-20">
        <Container size="narrow">
          <Card>
            <CardContent className="space-y-3 p-5 text-center md:p-8">
              <XCircle className="mx-auto text-[var(--color-text-muted)]" size={48} />
              <h1 className="font-display text-h2 font-bold">{t('notFoundTitle')}</h1>
              <p className="text-sm text-[var(--color-text-muted)]">{t('notFoundDescription')}</p>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  // Withdrawn without a replacement, or its holder's identity was revoked or
  // account suspended: the record is shown, but never as a valid document.
  const revoked = certificate.status === 'revoked';

  return (
    <section className="py-12 md:py-20">
      <Container size="narrow">
        <Card className={revoked ? 'border-2 border-[var(--color-danger)]' : 'border-2'}>
          <CardContent className="space-y-6 p-5 md:p-8">
            <div className="flex items-start gap-4" data-certificate-status={certificate.status}>
              <span
                className={`grid size-14 shrink-0 place-items-center rounded-full ${revoked ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]' : 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]'}`}
              >
                {revoked ? (
                  <XCircle size={32} weight="fill" aria-hidden="true" />
                ) : (
                  <CheckCircle size={32} weight="fill" aria-hidden="true" />
                )}
              </span>
              <div>
                <p className="text-xs font-bold tracking-wider text-[var(--color-text-muted)] uppercase">
                  {t('verification')}
                </p>
                <h1 className="font-display text-h2 font-bold">
                  {t(revoked ? 'revoked' : 'valid')}
                </h1>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {t(revoked ? 'revokedDescription' : 'validDescription')}
                </p>
              </div>
            </div>

            <dl className="grid gap-4 border-y border-[var(--color-border)] py-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">{t('participant')}</dt>
                <dd className="mt-1 text-xl font-semibold">{certificate.fullName}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">{t('program')}</dt>
                <dd className="mt-1 font-semibold">{certificate.testTitle}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">{t(certificate.learningAssessment ? 'learningAssessmentResult' : 'result')}</dt>
                <dd className="mt-1 font-semibold">
                  {t('score', { score: certificate.score, total: certificate.total })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">{t('issuedAt')}</dt>
                <dd className="mt-1 font-semibold">
                  {printedDate(certificate, htmlLanguage(locale))}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">{t('number')}</dt>
                <dd className="mt-1 font-mono text-sm break-all">
                  {certificate.certificateNumber}
                </dd>
              </div>
            </dl>

            <p className="text-sm text-[var(--color-text-muted)]">{t('compareHint')}</p>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
