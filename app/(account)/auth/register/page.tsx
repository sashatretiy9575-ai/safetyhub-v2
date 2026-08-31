import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { EmailOtpFlow } from '@/features/auth/email-otp-flow';

export default function RegisterPage() {
  return (
    <section className="py-8 md:py-14">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            <EmailOtpFlow intent="register" />
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
