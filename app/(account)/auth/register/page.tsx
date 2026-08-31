'use client';

import { useRef, useState } from 'react';
import { UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { clientRequest, clientRequestMessage } from '@/lib/client-request';
import {
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
  signUpSchema,
} from '@/lib/validation/auth';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import { FieldError, PasswordInput } from '@/features/auth/form-controls';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { legalDocumentHref, PRIVACY_POLICY, TERMS_POLICY } from '@/lib/legal';

type RegisterFieldErrors = Partial<
  Record<'email' | 'password' | 'passwordConfirm' | 'legalAccepted' | 'captcha', string>
>;

export default function RegisterPage() {
  const [form, setForm] = useState({
    email: '',
    password: '',
    passwordConfirm: '',
    legalAccepted: false,
  });
  const [fieldErrors, setFieldErrors] = useState<RegisterFieldErrors>({});
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const legalRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  const update = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((value) => ({ ...value, [field]: event.target.value }));
    setFieldErrors((value) => ({ ...value, [field]: undefined }));
  };

  const focusFirstInvalid = (errors: RegisterFieldErrors) => {
    const target = errors.email
      ? emailRef.current
      : errors.password
        ? passwordRef.current
        : errors.passwordConfirm
          ? confirmRef.current
          : errors.legalAccepted
            ? legalRef.current
            : null;
    requestAnimationFrame(() => target?.focus());
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = signUpSchema.safeParse({ ...form, captchaToken: captchaToken || undefined });
    const errors: RegisterFieldErrors = {};
    if (!parsed.success) {
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.email?.length) errors.email = 'Введите корректный email.';
      if (flattened.password?.length)
        errors.password = 'Минимум 12 символов: латинские заглавная, строчная буквы и цифра.';
      if (flattened.passwordConfirm?.length) errors.passwordConfirm = 'Пароли должны совпадать.';
      if (flattened.legalAccepted?.length) {
        errors.legalAccepted = 'Подтвердите согласие с действующими документами.';
      }
    }
    if (!parsed.success) {
      setFieldErrors(errors);
      setError('');
      focusFirstInvalid(errors);
      return;
    }

    const submitRequest = async (verifiedToken?: string) => {
      setLoading(true);
      setError('');
      setMessage('');
      setFieldErrors({});
      try {
        const result = await clientRequest('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: parsed.data.email,
            password: parsed.data.password,
            passwordConfirm: parsed.data.passwordConfirm,
            legalAccepted: parsed.data.legalAccepted,
            captchaToken: verifiedToken,
          }),
        });
        if (!result.ok) {
          setError(
            clientRequestMessage(result.error, 'Не удалось зарегистрироваться. Проверьте данные.'),
          );
          setCaptchaToken(null);
          setCaptchaVersion((value) => value + 1);
          return;
        }
        setMessage(
          'Если для этого email ещё нет аккаунта, мы отправили письмо со ссылкой подтверждения. Если аккаунт уже существует, войдите или восстановите пароль.',
        );
      } catch (requestError) {
        setError(
          clientRequestMessage(requestError, 'Не удалось зарегистрироваться. Попробуйте позже.'),
        );
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
    <section className="py-8 md:py-14">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-6 p-4 min-[320px]:p-6 md:p-8">
            <div className="space-y-2 text-center">
              <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <UserPlus size={24} />
              </span>
              <h1 className="font-display text-2xl font-bold">Создать аккаунт</h1>
              <p className="text-sm text-[var(--color-text-muted)]">
                Только email и пароль. Имя для сертификата подтвердим отдельно.
              </p>
            </div>
            {message ? (
              <div className="space-y-4">
                <p role="status" className="rounded-xl bg-[var(--color-primary-soft)] p-4 text-sm">
                  {message}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button asChild className="w-full">
                    <Link href="/auth/login">Войти</Link>
                  </Button>
                  <Button asChild variant="secondary" className="w-full">
                    <Link href="/auth/reset-password">Восстановить пароль</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    ref={emailRef}
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={update('email')}
                    invalid={Boolean(fieldErrors.email)}
                    aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                    required
                  />
                  <FieldError id="email-error" message={fieldErrors.email} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Пароль</Label>
                  <PasswordInput
                    ref={passwordRef}
                    id="password"
                    minLength={PASSWORD_MIN_CHARACTERS}
                    maxLength={PASSWORD_MAX_CHARACTERS}
                    autoComplete="new-password"
                    value={form.password}
                    onChange={update('password')}
                    invalid={Boolean(fieldErrors.password)}
                    aria-describedby="password-requirements password-error"
                    required
                  />
                  <p id="password-requirements" className="text-xs text-[var(--color-text-muted)]">
                    Минимум 12 символов: заглавная и строчная латинские буквы, цифра.
                  </p>
                  <FieldError id="password-error" message={fieldErrors.password} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="passwordConfirm">Повторите пароль</Label>
                  <PasswordInput
                    ref={confirmRef}
                    id="passwordConfirm"
                    minLength={PASSWORD_MIN_CHARACTERS}
                    maxLength={PASSWORD_MAX_CHARACTERS}
                    autoComplete="new-password"
                    value={form.passwordConfirm}
                    onChange={update('passwordConfirm')}
                    invalid={Boolean(fieldErrors.passwordConfirm)}
                    aria-describedby={
                      fieldErrors.passwordConfirm ? 'password-confirm-error' : undefined
                    }
                    required
                  />
                  <FieldError id="password-confirm-error" message={fieldErrors.passwordConfirm} />
                </div>
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-start gap-3 text-sm leading-5">
                    <input
                      ref={legalRef}
                      id="legalAccepted"
                      type="checkbox"
                      checked={form.legalAccepted}
                      onChange={(event) => {
                        setForm((value) => ({ ...value, legalAccepted: event.target.checked }));
                        setFieldErrors((value) => ({ ...value, legalAccepted: undefined }));
                      }}
                      aria-invalid={fieldErrors.legalAccepted ? true : undefined}
                      aria-describedby={
                        fieldErrors.legalAccepted ? 'legal-acceptance-error' : undefined
                      }
                      className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
                    />
                    <span>
                      Принимаю{' '}
                      <Link
                        href={legalDocumentHref('terms', TERMS_POLICY.version)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-[var(--color-primary)] underline"
                      >
                        Условия версии {TERMS_POLICY.version}
                      </Link>{' '}
                      и{' '}
                      <Link
                        href={legalDocumentHref('privacy', PRIVACY_POLICY.version)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-[var(--color-primary)] underline"
                      >
                        Политику версии {PRIVACY_POLICY.version}
                      </Link>
                      .
                    </span>
                  </label>
                  <FieldError id="legal-acceptance-error" message={fieldErrors.legalAccepted} />
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
                <FieldError id="captcha-error" message={fieldErrors.captcha} />
                {error && (
                  <p role="alert" className="text-sm text-[var(--color-danger)]">
                    {error}
                  </p>
                )}
                <Button type="submit" className="min-h-11 w-full" disabled={loading}>
                  {loading ? 'Создаём...' : 'Создать аккаунт'}
                </Button>
              </form>
            )}
            {!message && (
              <p className="text-center text-sm text-[var(--color-text-muted)]">
                Уже есть аккаунт?{' '}
                <Link
                  href="/auth/login"
                  className="font-medium text-[var(--color-primary)] hover:underline"
                >
                  Войти
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
