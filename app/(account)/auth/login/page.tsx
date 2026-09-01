import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { EmailOtpFlow } from '@/features/auth/email-otp-flow';
import { ZhUsernamePasswordFlow } from '@/features/auth/zh-username-password-flow';
import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

type LoginPageProps = {
  searchParams: Promise<{ registered?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [locale, query] = await Promise.all([getLocale(), searchParams]);
  if (locale === 'zh' && !rolloutFeatureEnabled('zhUsernamePassword')) notFound();
  const registrationComplete = query.registered === '1';
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            {locale === 'zh' ? (
              <ZhUsernamePasswordFlow
                mode="login"
                registrationComplete={registrationComplete}
              />
            ) : (
              <EmailOtpFlow intent="login" />
            )}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
