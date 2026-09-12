import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { localizePathname, type AppLocale } from '@/i18n/config';

/**
 * Shown on the old password pages (change, reset, update, invite). Password
 * authentication is retired; the page only points back to the code login.
 */
export async function PasswordAuthRetiredPage() {
  const [locale, t] = await Promise.all([
    getLocale() as Promise<AppLocale>,
    getTranslations('AuthOtp'),
  ]);
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-5 p-6 md:p-8">
            <div className="space-y-2">
              <h1 className="font-display text-2xl font-bold">{t('retiredTitle')}</h1>
              <p className="text-sm text-[var(--color-text-muted)]">{t('retiredDescription')}</p>
            </div>
            <Button asChild className="w-full">
              <Link href={localizePathname('/auth/login', locale)}>{t('retiredAction')}</Link>
            </Button>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
