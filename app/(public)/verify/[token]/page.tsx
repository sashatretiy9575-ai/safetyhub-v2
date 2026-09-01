export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { CheckCircle, XCircle } from '@phosphor-icons/react/dist/ssr';
import { getPublicCertificateVerification } from '@/features/certificates/server';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';
import { getLocale, getTranslations } from 'next-intl/server';
import { htmlLanguage } from '@/i18n/config';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Certificate');
  return {
    title: t('verifyMetadataTitle'),
    description: t('verifyMetadataDescription'),
    robots: { index: false, follow: false },
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
              <h1 className="font-display text-2xl font-bold">{t('notFoundTitle')}</h1>
              <p className="text-sm text-[var(--color-text-muted)]">{t('notFoundDescription')}</p>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  const revoked = certificate.revokedAt !== null;
  return (
    <section className="py-12 md:py-20">
      <Container size="narrow">
        <Card className={revoked ? 'border-2 border-[var(--color-danger)]' : 'border-2'}>
          <CardContent className="space-y-6 p-5 md:p-8">
            <div className="flex items-start gap-4">
              <span
                className={`grid size-14 shrink-0 place-items-center rounded-full ${
                  revoked
                    ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
                    : 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]'
                }`}
              >
                {revoked ? (
                  <XCircle size={32} weight="fill" />
                ) : (
                  <CheckCircle size={32} weight="fill" />
                )}
              </span>
              <div>
                <p className="text-xs font-bold tracking-wider text-[var(--color-text-muted)] uppercase">
                  {t('verification')}
                </p>
                <h1 className="font-display text-2xl font-bold md:text-3xl">
                  {revoked ? t('revoked') : t('valid')}
                </h1>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {revoked
                    ? t('revokedDescription')
                    : t('validDescription')}
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
                <dt className="text-xs text-[var(--color-text-muted)]">{t('result')}</dt>
                <dd className="mt-1 font-semibold">
                  {t('score', { score: certificate.score, total: certificate.total })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">{t('issuedAt')}</dt>
                <dd className="mt-1 font-semibold">
                  {new Date(certificate.issuedAt).toLocaleDateString(htmlLanguage(locale))}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">{t('number')}</dt>
                <dd className="mt-1 font-mono text-sm break-all">
                  {certificate.certificateNumber}
                </dd>
              </div>
              {certificate.revokedAt && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-[var(--color-text-muted)]">{t('revokedAt')}</dt>
                  <dd className="mt-1 font-semibold text-[var(--color-danger)]">
                    {new Date(certificate.revokedAt).toLocaleString(htmlLanguage(locale))}
                  </dd>
                </div>
              )}
            </dl>

            <p className="text-sm text-[var(--color-text-muted)]">
              {t('compareHint')}
            </p>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
