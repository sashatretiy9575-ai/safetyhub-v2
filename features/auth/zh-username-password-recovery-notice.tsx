import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';

/** Chinese account recovery is an administrator-mediated process only. */
export function ZhUsernamePasswordRecoveryNotice() {
  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-4 p-6 md:p-8">
            <h1 className="font-display text-2xl font-bold">账号恢复</h1>
            <p className="text-sm leading-6 text-[var(--color-text-muted)]">
              中文账号没有自助恢复渠道。请联系管理员；管理员核验后可协助重设密码。
            </p>
            <Link
              href="/zh/auth/login"
              className="inline-flex min-h-11 items-center font-medium text-[var(--color-primary)] hover:underline"
            >
              返回登录
            </Link>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
