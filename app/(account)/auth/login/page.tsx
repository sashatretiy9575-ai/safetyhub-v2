import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { EmailOtpFlow } from '@/features/auth/email-otp-flow';
import { ZhUsernamePasswordFlow } from '@/features/auth/zh-username-password-flow';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';
import type { AppLocale } from '@/i18n/config';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getPrivateRequestLocale()) as AppLocale;
  const t = await getTranslations({ locale, namespace: 'AuthOtp' });
  return {
    title: `${t('loginTitle')} — SafetyHub.kz`,
  };
}

type LoginPageProps = {
  searchParams: Promise<{
    deletionRequested?: string | string[];
    realmChanged?: string | string[];
    signedOut?: string | string[];
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [locale, query] = await Promise.all([getPrivateRequestLocale(), searchParams]);
  const [deletionTranslations, languageTranslations] = await Promise.all([
    getTranslations({ locale, namespace: 'AccountDeletion' }),
    getTranslations({ locale, namespace: 'Shell.language' }),
  ]);
  if (locale === 'zh' && !rolloutFeatureEnabled('zhUsernamePassword')) notFound();
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            {query.deletionRequested === '1' ? (
              <p
                role="status"
                className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
              >
                {deletionTranslations('requested')}
              </p>
            ) : null}
            {query.realmChanged === '1' ? (
              <p
                role="status"
                className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
              >
                {languageTranslations('sessionEnded')}
              </p>
            ) : null}
            {query.signedOut === '1' ? (
              <p
                role="status"
                className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
              >
                {languageTranslations('signedOut')}
              </p>
            ) : null}
            {locale === 'zh' ? <ZhUsernamePasswordFlow /> : <EmailOtpFlow />}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
