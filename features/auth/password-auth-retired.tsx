import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { NextResponse } from '@/lib/security/api-response';
import { getSiteUrl } from '@/features/auth/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { localizePathname, type AppLocale } from '@/i18n/config';

export const PASSWORD_AUTH_RETIRED_ERROR = 'PASSWORD_AUTH_RETIRED';

export function passwordAuthRetiredResponse() {
  return NextResponse.json(
    {
      error: PASSWORD_AUTH_RETIRED_ERROR,
    },
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    },
  );
}

/**
 * Old confirmation, recovery, and invite links must never exchange a code or
 * create a session after password authentication is retired. The destination
 * intentionally discards the caller-controlled query and fragment state.
 */
export function redirectFromRetiredPasswordLink() {
  const response = NextResponse.redirect(new URL('/auth/login', getSiteUrl()), 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex');
  return response;
}

export async function PasswordAuthRetiredPage() {
  const [locale, t] = await Promise.all([
    getLocale() as Promise<AppLocale>,
    getTranslations('AuthOtp'),
  ]);
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-5 p-4 min-[320px]:p-6 md:p-8">
            <div className="space-y-2">
              <h1 className="font-display text-2xl font-bold">{t('retiredTitle')}</h1>
              <p className="text-sm text-[var(--color-text-muted)]">
                {t('retiredDescription')}
              </p>
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
