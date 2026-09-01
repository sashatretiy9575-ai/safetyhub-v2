import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { EmailOtpFlow } from '@/features/auth/email-otp-flow';
import { ZhPasskeyFlow } from '@/features/auth/zh-passkey-flow';
import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

export default async function LoginPage() {
  const locale = await getLocale();
  if (locale === 'zh' && !rolloutFeatureEnabled('zhPasskey')) notFound();
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            {locale === 'zh' ? <ZhPasskeyFlow mode="login" /> : <EmailOtpFlow intent="login" />}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
