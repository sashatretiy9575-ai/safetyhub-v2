export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AuthenticationError, requireUser } from '@/features/auth/server';
import { isZhUsernamePasswordMinimalApplication } from '@/features/auth/zh-username-password-minimal-application';
import { OnboardingForm } from '@/features/profile/onboarding-form';
import { getProfileAvatarUrl } from '@/features/profile/server';
import { phoneCountryOptions, phoneInputValueFromE164 } from '@/lib/phone';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { localizePathname, type AppLocale } from '@/i18n/config';

export default async function OnboardingPage() {
  const locale = (await getLocale()) as AppLocale;
  const t = await getTranslations('Profile');
  let context: Awaited<ReturnType<typeof requireUser>>;
  try {
    context = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationError && error.status === 401) {
      redirect(
        `${localizePathname('/auth/login', locale)}?return=${encodeURIComponent(localizePathname('/onboarding', locale))}`,
      );
    }
    if (error instanceof AuthenticationError && error.code === 'LEGAL_ACCEPTANCE_REQUIRED') {
      redirect(localizePathname('/auth/legal', locale));
    }
    throw error;
  }

  if (isZhUsernamePasswordMinimalApplication(context)) {
    redirect(localizePathname('/profile', locale));
  }

  const profile = context.profile as typeof context.profile & {
    organization?: string;
    onboarding_completed_at?: string | null;
  };
  const avatarUrl = profile.avatar_updated_at ? await getProfileAvatarUrl(context.user.id) : null;
  if (profile.onboarding_completed_at && avatarUrl) {
    redirect(
      localizePathname(context.approval.state === 'approved' ? '/topics' : '/profile', locale),
    );
  }

  return (
    <section className="py-8 md:py-14">
      <Container size="narrow">
        <div className="mx-auto max-w-2xl space-y-5">
          <div className="text-center">
            <p className="text-sm font-semibold text-[var(--color-primary)]">
              {t('onboardingEyebrow')}
            </p>
            <h1 className="font-display mt-1 text-3xl font-black md:text-4xl">
              {t('onboardingTitle')}
            </h1>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--color-text-muted)]">
              {t('onboardingDescription')}
            </p>
          </div>
          <Card>
            <CardContent className="p-4 sm:p-6 md:p-8">
              <OnboardingForm
                countryOptions={phoneCountryOptions()}
                initial={{
                  name: profile.name,
                  surname: profile.surname,
                  job: profile.job,
                  organization: profile.organization ?? '',
                  phone: phoneInputValueFromE164(
                    context.profile.phone_country_iso2,
                    context.profile.phone_e164,
                  ),
                }}
                initialAvatarUrl={avatarUrl}
              />
            </CardContent>
          </Card>
        </div>
      </Container>
    </section>
  );
}
