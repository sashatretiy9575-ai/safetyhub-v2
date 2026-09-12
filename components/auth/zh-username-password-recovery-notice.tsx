import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { localizePathname } from '@/i18n/config';

/** Chinese account recovery is an administrator-mediated process only. */
export async function ZhUsernamePasswordRecoveryNotice() {
  const t = await getTranslations('AuthOtp');
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-4 p-6 md:p-8">
            <h1 className="font-display text-2xl font-bold">{t('zhRecoveryTitle')}</h1>
            <p className="text-sm leading-6 text-[var(--color-text-muted)]">
              {t('zhRecoveryDescription')}
            </p>
            <Link
              href={localizePathname('/auth/login', 'zh')}
              className="inline-flex min-h-11 items-center font-medium text-[var(--color-primary)] hover:underline"
            >
              {t('zhRecoveryBack')}
            </Link>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
