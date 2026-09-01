import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { EmailOtpFlow } from '@/features/auth/email-otp-flow';
import { ZhUsernamePasswordFlow } from '@/features/auth/zh-username-password-flow';
import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

export default async function RegisterPage() {
  const locale = await getLocale();
  if (locale === 'zh' && !rolloutFeatureEnabled('zhUsernamePassword')) notFound();
  return (
    <section className="py-8 md:py-14">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            {locale === 'zh' ? (
              <ZhUsernamePasswordFlow mode="register" />
            ) : (
              <EmailOtpFlow intent="register" />
            )}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
