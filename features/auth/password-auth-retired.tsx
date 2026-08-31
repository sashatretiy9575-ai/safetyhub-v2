import Link from 'next/link';
import { NextResponse } from '@/lib/security/api-response';
import { getSiteUrl } from '@/features/auth/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';

export const PASSWORD_AUTH_RETIRED_ERROR = 'PASSWORD_AUTH_RETIRED';

const RETIRED_MESSAGE =
  'Пароли, восстановление пароля и приглашения больше не используются. Войдите или зарегистрируйтесь по одноразовому коду из письма.';

export function passwordAuthRetiredResponse() {
  return NextResponse.json(
    {
      error: PASSWORD_AUTH_RETIRED_ERROR,
      message: 'Password authentication has been retired. Use the email OTP flow instead.',
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

export function PasswordAuthRetiredPage() {
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-5 p-4 min-[320px]:p-6 md:p-8">
            <div className="space-y-2">
              <h1 className="font-display text-2xl font-bold">Вход только по коду</h1>
              <p className="text-sm text-[var(--color-text-muted)]">{RETIRED_MESSAGE}</p>
            </div>
            <Button asChild className="w-full">
              <Link href="/auth/login">Получить код на email</Link>
            </Button>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
