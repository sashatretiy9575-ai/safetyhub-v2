export const dynamic = 'force-dynamic';

import { inspectPasswordChangeContext, verifiedSessionId } from '@/features/auth/password-change';
import { PasswordRecoveryFlow } from '@/features/auth/password-recovery-flow';
import { createClient } from '@/lib/supabase/server';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';

async function hasVerifiedRecoveryContext() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getSession();
    const session = data.session;
    if (error || !session?.user) return false;
    const sessionId = await verifiedSessionId(supabase, session.access_token, session.user.id);
    const context = await inspectPasswordChangeContext(session.user.id, sessionId);
    return context?.kind === 'recovery';
  } catch {
    return false;
  }
}

export default async function ResetPasswordPage() {
  const initialVerified = await hasVerifiedRecoveryContext();

  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            <PasswordRecoveryFlow initialVerified={initialVerified} />
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
