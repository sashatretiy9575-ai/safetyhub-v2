'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignIn } from '@phosphor-icons/react';
import Link from 'next/link';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { signInSchema } from '@/lib/validation/auth';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import { FieldError, PasswordInput } from '@/features/auth/form-controls';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<'email' | 'password' | 'captcha', string>>
  >({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = signInSchema.safeParse({
      email,
      password,
      captchaToken: captchaToken || undefined,
    });
    const errors: typeof fieldErrors = {};
    if (!parsed.success) {
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.email?.length) errors.email = 'Введите корректный email.';
      if (flattened.password?.length) errors.password = 'Введите пароль.';
    }
    if (!parsed.success) {
      setFieldErrors(errors);
      setError('');
      requestAnimationFrame(() =>
        (errors.email ? emailRef.current : errors.password ? passwordRef.current : null)?.focus(),
      );
      return;
    }

    const submitRequest = async (verifiedToken?: string) => {
      setLoading(true);
      setError('');
      setFieldErrors({});
      try {
        const result = await clientRequest('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: parsed.data.email,
            password: parsed.data.password,
            captchaToken: verifiedToken,
          }),
        });
        if (!result.ok) {
          setError(clientRequestMessage(result.error, 'Неверный email или пароль'));
          setCaptchaToken(null);
          setCaptchaVersion((value) => value + 1);
          return;
        }
        const payload = await readClientResponseJson<{ redirectTo?: unknown }>(result.response);
        const redirectTo = payload?.redirectTo === '/admin' ? '/admin' : '/profile';
        router.replace(redirectTo);
        router.refresh();
      } catch (requestError) {
        setError(clientRequestMessage(requestError, 'Не удалось войти. Повторите позже.'));
        setCaptchaToken(null);
        setCaptchaVersion((value) => value + 1);
      } finally {
        setLoading(false);
      }
    };

    if (captchaRequired && !captchaToken) {
      pendingCaptchaSubmitRef.current = (token) => void submitRequest(token);
      setFieldErrors({});
      setError('');
      turnstileRef.current?.execute();
      return;
    }

    await submitRequest(captchaToken ?? undefined);
  };

  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            <div className="space-y-2 text-center">
              <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <SignIn size={24} />
              </span>
              <h1 className="font-display text-2xl font-bold">Вход в аккаунт</h1>
              <p className="text-sm text-[var(--color-text-muted)]">Введите email и пароль.</p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  ref={emailRef}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setFieldErrors((value) => ({ ...value, email: undefined }));
                  }}
                  invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
                  required
                />
                <FieldError id="login-email-error" message={fieldErrors.email} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Пароль</Label>
                <PasswordInput
                  id="password"
                  ref={passwordRef}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFieldErrors((value) => ({ ...value, password: undefined }));
                  }}
                  invalid={Boolean(fieldErrors.password)}
                  aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
                  required
                />
                <FieldError id="login-password-error" message={fieldErrors.password} />
              </div>
              <Turnstile
                key={captchaVersion}
                ref={turnstileRef}
                onToken={(token) => {
                  setCaptchaToken(token);
                  if (token) {
                    setFieldErrors((value) => ({ ...value, captcha: undefined }));
                    const pending = pendingCaptchaSubmitRef.current;
                    pendingCaptchaSubmitRef.current = null;
                    pending?.(token);
                  }
                }}
              />
              <FieldError id="login-captcha-error" message={fieldErrors.captcha} />
              {error && (
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  {error}
                </p>
              )}
              <Button type="submit" className="min-h-11 w-full" disabled={loading}>
                {loading ? 'Входим...' : 'Войти'}
              </Button>
            </form>
            <div className="space-y-2 text-center text-sm">
              <Link
                href="/auth/reset-password"
                className="inline-flex min-h-11 items-center justify-center px-2 text-[var(--color-primary)] hover:underline"
              >
                Забыли пароль?
              </Link>
              <p className="text-[var(--color-text-muted)]">
                Нет аккаунта?{' '}
                <Link
                  href="/auth/register"
                  className="font-medium text-[var(--color-primary)] hover:underline"
                >
                  Регистрация
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
