export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { CheckCircle, XCircle } from '@phosphor-icons/react/dist/ssr';
import { getPublicCertificateVerification } from '@/features/certificates/server';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Проверка сертификата',
  description: 'Проверка подлинности и текущего статуса сертификата SafetyHub.kz.',
  robots: { index: false, follow: false },
};

export default async function VerifyCertificatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const certificate = await getPublicCertificateVerification(token);
  if (!certificate) {
    return (
      <section className="py-12 md:py-20">
        <Container size="narrow">
          <Card>
            <CardContent className="space-y-3 p-5 text-center md:p-8">
              <XCircle className="mx-auto text-[var(--color-text-muted)]" size={48} />
              <h1 className="font-display text-2xl font-bold">Документ не найден</h1>
              <p className="text-sm text-[var(--color-text-muted)]">
                Ссылка недействительна либо сертификат и связанная с ним учётная запись удалены.
              </p>
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
                  Проверка сертификата
                </p>
                <h1 className="font-display text-2xl font-bold md:text-3xl">
                  {revoked ? 'Сертификат отозван' : 'Сертификат действует'}
                </h1>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {revoked
                    ? 'Запись подлинная, но сертификат больше не действует.'
                    : 'Подлинность подтверждена записью SafetyHub.kz.'}
                </p>
              </div>
            </div>

            <dl className="grid gap-4 border-y border-[var(--color-border)] py-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">Участник</dt>
                <dd className="mt-1 text-xl font-semibold">{certificate.fullName}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">Программа</dt>
                <dd className="mt-1 font-semibold">{certificate.testTitle}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">Результат</dt>
                <dd className="mt-1 font-semibold">
                  {certificate.score} из {certificate.total}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">Дата выдачи</dt>
                <dd className="mt-1 font-semibold">
                  {new Date(certificate.issuedAt).toLocaleDateString('ru-RU')}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-muted)]">Номер</dt>
                <dd className="mt-1 font-mono text-sm break-all">
                  {certificate.certificateNumber}
                </dd>
              </div>
              {certificate.revokedAt && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-[var(--color-text-muted)]">Отозван</dt>
                  <dd className="mt-1 font-semibold text-[var(--color-danger)]">
                    {new Date(certificate.revokedAt).toLocaleString('ru-RU')}
                  </dd>
                </div>
              )}
            </dl>

            <p className="text-sm text-[var(--color-text-muted)]">
              Сверьте имя, программу, результат и номер с данными в PDF. Изменённый документ не
              изменяет эту серверную запись.
            </p>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
