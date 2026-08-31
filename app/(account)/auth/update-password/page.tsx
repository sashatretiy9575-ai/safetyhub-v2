export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { inspectPasswordChangeContext, verifiedSessionId } from '@/features/auth/password-change';
import type { PasswordChangeContext } from '@/features/auth/password-change';
import { PasswordChangeForm } from '@/features/auth/password-change-form';
import { AuthenticationError, requireUser } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';

export default async function UpdatePasswordPage() {
  let userContext;
  try {
    userContext = await requireUser({ enforceLegal: false });
  } catch (error) {
    if (error instanceof AuthenticationError && error.status === 503) throw error;
    redirect('/auth/reset-password?error=invalid-recovery');
  }
  let passwordContext: PasswordChangeContext | null = null;
  try {
    const supabase = await createClient();
    const session = await supabase.auth.getSession();
    if (session.data.session) {
      const sessionId = await verifiedSessionId(
        supabase,
        session.data.session.access_token,
        userContext.user.id,
      );
      passwordContext = await inspectPasswordChangeContext(userContext.user.id, sessionId);
    }
  } catch {
    passwordContext = null;
  }

  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-5 p-4 min-[320px]:p-6 md:p-8">
            {passwordContext ? (
              <>
                <div>
                  <h1 className="font-display text-2xl font-bold">
                    {passwordContext.kind === 'invite' ? 'Создайте пароль' : 'Новый пароль'}
                  </h1>
                  <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                    Одноразовое подтверждение действует 15 минут и сработает только один раз.
                  </p>
                </div>
                <PasswordChangeForm mode={passwordContext.kind} />
              </>
            ) : (
              <div className="space-y-4">
                <h1 className="font-display text-2xl font-bold">Подтверждение недействительно</h1>
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  Для этой страницы нужно новое одноразовое подтверждение восстановления или
                  приглашения. Обычная активная сессия не подтверждает смену пароля.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline">
                    <Link href="/auth/change-password">Сменить по текущему паролю</Link>
                  </Button>
                  <Button asChild variant="ghost">
                    <Link href="/auth/reset-password">Запросить восстановление</Link>
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
