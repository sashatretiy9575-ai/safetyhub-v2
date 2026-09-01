export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { LegalAcceptanceGate } from '@/features/auth/legal-acceptance-gate';
import { AuthenticationError, requireUser } from '@/features/auth/server';
import { localizePathname, type AppLocale } from '@/i18n/config';
import { getCurrentLegalPolicies } from '@/lib/legal-current';

function authenticatedLanding(context: Awaited<ReturnType<typeof requireUser>>) {
  if (context.role === 'admin') return '/admin' as const;
  return context.profile.onboarding_completed_at === null
    ? ('/onboarding' as const)
    : ('/profile' as const);
}

export default async function LegalAcceptancePage() {
  const locale = (await getLocale()) as AppLocale;
  let context: Awaited<ReturnType<typeof requireUser>>;
  try {
    context = await requireUser({ enforceLegal: false });
  } catch (error) {
    if (error instanceof AuthenticationError && error.status === 401) {
      const returnTo = localizePathname('/auth/legal', locale);
      redirect(`${localizePathname('/auth/login', locale)}?return=${encodeURIComponent(returnTo)}`);
    }
    throw error;
  }

  const landing = authenticatedLanding(context);
  const continueTo = landing === '/admin' ? landing : localizePathname(landing, locale);
  if (context.hasCurrentLegalAcceptance) redirect(continueTo);
  const currentPolicies = await getCurrentLegalPolicies();

  return (
    <section className="py-8 md:py-14">
      <Container size="narrow">
        <Card className="mx-auto max-w-2xl">
          <CardContent className="p-4 sm:p-6 md:p-8">
            <LegalAcceptanceGate continueTo={continueTo} currentPolicies={currentPolicies} />
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
