export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { AuthenticationError, requireUser } from '@/features/auth/server';
import { PasswordChangeForm } from '@/features/auth/password-change-form';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';

export default async function ChangePasswordPage() {
  try {
    await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationError && error.status !== 503) {
      redirect('/auth/login');
    }
    throw error;
  }

  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-5 p-4 min-[320px]:p-6 md:p-8">
            <div>
              <h1 className="font-display text-2xl font-bold">Сменить пароль</h1>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                Подтвердите текущий пароль. После изменения остальные сеансы будут завершены.
              </p>
            </div>
            <PasswordChangeForm mode="current" />
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
