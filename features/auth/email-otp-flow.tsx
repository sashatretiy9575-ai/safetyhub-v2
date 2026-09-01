'use client';

import { useEffect, useRef, useState } from 'react';
import { SignIn, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FieldError } from '@/features/auth/form-controls';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { emailOtpStartSchema, emailOtpVerifySchema } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type EmailOtpIntent = 'login' | 'register';
type EmailOtpStage = 'email' | 'code';
type BusyAction = 'send' | 'verify' | null;
type StoredAttempt = {
  email: string;
  intent: EmailOtpIntent;
  sentAt: number;
};
type FieldErrors = Partial<Record<'email' | 'code' | 'captcha', string>>;

const ATTEMPT_TTL_MS = 60 * 60 * 1000;
const RESEND_DELAY_SECONDS = 60;

const sendErrorMessages: Record<string, string> = {
  CAPTCHA_FAILED: 'Проверка безопасности истекла. Пройдите её снова.',
  RATE_LIMITED: 'Слишком много запросов. Попробуйте немного позже.',
  INVALID_REQUEST: 'Проверьте введённый email.',
  OTP_UNAVAILABLE: 'Не удалось отправить код. Повторите позже.',
};

const verifyErrorMessages: Record<string, string> = {
  OTP_CODE_INVALID: 'Код неверен, истёк или уже использован. Проверьте его либо запросите новый.',
  RATE_LIMITED: 'Слишком много попыток. Попробуйте немного позже.',
  INVALID_REQUEST: 'Введите email и шестизначный код.',
  OTP_UNAVAILABLE: 'Не удалось проверить код. Повторите позже.',
  AUTH_CONTEXT_UNAVAILABLE: 'Сессия подтверждена, но профиль пока недоступен. Повторите позже.',
};

function storageKey(intent: EmailOtpIntent) {
  return `safetyhub-email-otp:${intent}`;
}

function readStoredAttempt(intent: EmailOtpIntent): StoredAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(intent)) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<StoredAttempt>;
    const parsedEmail = emailOtpStartSchema.safeParse({
      email: candidate.email,
      intent,
    });
    if (
      !parsedEmail.success ||
      candidate.intent !== intent ||
      typeof candidate.sentAt !== 'number' ||
      Date.now() - candidate.sentAt > ATTEMPT_TTL_MS
    ) {
      sessionStorage.removeItem(storageKey(intent));
      return null;
    }
    return {
      email: parsedEmail.data.email,
      intent,
      sentAt: candidate.sentAt,
    };
  } catch {
    return null;
  }
}

function storeAttempt(intent: EmailOtpIntent, email: string, sentAt: number) {
  try {
    sessionStorage.setItem(
      storageKey(intent),
      JSON.stringify({
        email,
        intent,
        sentAt,
      } satisfies StoredAttempt),
    );
  } catch {
    // A storage-denied browser can still complete the flow while the page stays open.
  }
}

function clearStoredAttempt(intent: EmailOtpIntent) {
  try {
    sessionStorage.removeItem(storageKey(intent));
  } catch {
    // Nothing client-side is authoritative for an OTP session.
  }
}

function safeLanding(value: unknown) {
  return value === '/admin' ||
    value === '/auth/legal' ||
    value === '/onboarding' ||
    value === '/profile'
    ? value
    : '/profile';
}

export function EmailOtpFlow({ intent }: { intent: EmailOtpIntent }) {
  const router = useRouter();
  const [stage, setStage] = useState<EmailOtpStage>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentAt, setSentAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const isRegister = intent === 'register';

  useEffect(() => {
    const stored = readStoredAttempt(intent);
    if (!stored) return;
    setEmail(stored.email);
    setSentAt(stored.sentAt);
    setRetrySeconds(
      Math.max(0, Math.ceil((stored.sentAt + RESEND_DELAY_SECONDS * 1000 - Date.now()) / 1000)),
    );
    setStage('code');
    setStatus('Введите код из письма. Если письмо не пришло, запросите новый код.');
  }, [intent]);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const timer = window.setInterval(() => setRetrySeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [retrySeconds]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (stage === 'code') codeRef.current?.focus();
      else emailRef.current?.focus();
    });
  }, [stage]);

  const resetCaptcha = () => {
    pendingCaptchaSubmitRef.current = null;
    setCaptchaVersion((value) => value + 1);
  };

  const sendCode = async (normalizedEmail: string, captchaToken?: string) => {
    setBusy('send');
    setError('');
    setFieldErrors({});
    try {
      const result = await clientRequest('/api/auth/email-otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normalizedEmail,
          intent,
          captchaToken,
        }),
      });
      const payload = await readClientResponseJson<{ sent?: unknown; error?: unknown }>(result.response);
      if (!result.ok || payload?.sent !== true) {
        const errorCode = typeof payload?.error === 'string' ? payload.error : null;
        const fallbackMessage = result.ok
          ? 'Не удалось отправить код. Повторите позже.'
          : clientRequestMessage(result.error, 'Не удалось отправить код. Повторите позже.');
        setError(
          (errorCode && sendErrorMessages[errorCode]) || fallbackMessage,
        );
        return;
      }

      const nextSentAt = Date.now();
      setEmail(normalizedEmail);
      setCode('');
      setSentAt(nextSentAt);
      setRetrySeconds(RESEND_DELAY_SECONDS);
      setStage('code');
      setStatus('Если этот адрес можно использовать, код отправлен. Введите шесть цифр из письма.');
      storeAttempt(intent, normalizedEmail, nextSentAt);
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось отправить код. Повторите позже.'));
    } finally {
      resetCaptcha();
      setBusy(null);
    }
  };

  const requestCode = (event?: React.FormEvent | React.MouseEvent) => {
    event?.preventDefault();
    if (busy || (stage === 'code' && retrySeconds > 0)) return;
    const parsed = emailOtpStartSchema.safeParse({
      email,
      intent,
    });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.email?.length) nextErrors.email = 'Введите корректный email.';
      setFieldErrors(nextErrors);
      setError('');
      requestAnimationFrame(() => emailRef.current?.focus());
      return;
    }

    if (captchaRequired) {
      pendingCaptchaSubmitRef.current = (token) => void sendCode(parsed.data.email, token);
      setError('');
      setFieldErrors({});
      turnstileRef.current?.execute();
      return;
    }
    void sendCode(parsed.data.email);
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const parsed = emailOtpVerifySchema.safeParse({
      email,
      code,
    });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.email?.length) nextErrors.email = 'Введите корректный email.';
      if (flattened.code?.length) nextErrors.code = 'Введите шестизначный код.';
      setFieldErrors(nextErrors);
      setError('');
      requestAnimationFrame(() => (nextErrors.email ? emailRef.current : codeRef.current)?.focus());
      return;
    }

    setBusy('verify');
    setError('');
    setFieldErrors({});
    try {
      const result = await clientRequest('/api/auth/email-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const payload = await readClientResponseJson<{ verified?: unknown; redirectTo?: unknown; error?: unknown }>(
        result.response,
      );
      if (!result.ok || payload?.verified !== true) {
        const errorCode = typeof payload?.error === 'string' ? payload.error : null;
        const fallbackMessage = result.ok
          ? 'Не удалось проверить код. Повторите позже.'
          : clientRequestMessage(result.error, 'Не удалось проверить код. Повторите позже.');
        setError(
          (errorCode && verifyErrorMessages[errorCode]) || fallbackMessage,
        );
        if (errorCode === 'OTP_CODE_INVALID') {
          setCode('');
          requestAnimationFrame(() => codeRef.current?.focus());
        }
        return;
      }

      clearStoredAttempt(intent);
      router.replace(safeLanding(payload?.redirectTo));
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось проверить код. Повторите позже.'));
    } finally {
      setBusy(null);
    }
  };

  const changeEmail = () => {
    clearStoredAttempt(intent);
    setStage('email');
    setCode('');
    setSentAt(0);
    setRetrySeconds(0);
    setError('');
    setStatus('');
    setFieldErrors({});
  };

  const Icon = isRegister ? UserPlus : SignIn;
  const title = isRegister ? 'Создать аккаунт' : 'Вход или регистрация';

  return (
    <>
      <div className="space-y-2 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <Icon size={24} />
        </span>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {stage === 'email'
            ? 'Укажите email — пришлём одноразовый шестизначный код.'
            : 'Введите код из письма. Он действует ограниченное время и используется один раз.'}
        </p>
      </div>

      {status && (
        <p role="status" className="rounded-xl bg-[var(--color-primary-soft)] p-4 text-sm">
          {status}
        </p>
      )}

      {stage === 'email' && (
        <form onSubmit={requestCode} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={`${intent}-email`}>Email</Label>
            <Input
              id={`${intent}-email`}
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((value) => ({ ...value, email: undefined }));
              }}
              invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? `${intent}-email-error` : undefined}
              required
            />
            <FieldError id={`${intent}-email-error`} message={fieldErrors.email} />
          </div>

          <Button type="submit" className="min-h-11 w-full" disabled={busy !== null}>
            {busy === 'send' ? 'Отправляем...' : 'Получить код'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-full"
            disabled={busy !== null}
            onClick={() => {
              setStage('code');
              setStatus('Введите email и код из уже полученного письма.');
              setError('');
            }}
          >
            У меня уже есть код
          </Button>
        </form>
      )}

      {stage === 'code' && (
        <form onSubmit={verifyCode} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={`${intent}-code-email`}>Email</Label>
            <Input
              id={`${intent}-code-email`}
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                const nextEmail = event.target.value;
                setEmail(nextEmail);
                const parsed = emailOtpStartSchema.safeParse({
                  email: nextEmail,
                  intent,
                });
                if (sentAt > 0 && parsed.success) storeAttempt(intent, parsed.data.email, sentAt);
                setFieldErrors((value) => ({ ...value, email: undefined }));
              }}
              invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? `${intent}-code-email-error` : undefined}
              required
            />
            <FieldError id={`${intent}-code-email-error`} message={fieldErrors.email} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${intent}-code`}>Код из письма</Label>
            <Input
              id={`${intent}-code`}
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              enterKeyHint="done"
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/gu, '').slice(0, 6));
                setFieldErrors((value) => ({ ...value, code: undefined }));
              }}
              className="text-center font-mono text-xl tracking-[0.3em] sm:text-xl"
              invalid={Boolean(fieldErrors.code)}
              aria-describedby={fieldErrors.code ? `${intent}-code-error` : undefined}
              required
            />
            <FieldError id={`${intent}-code-error`} message={fieldErrors.code} />
          </div>
          <Button type="submit" className="min-h-11 w-full" disabled={busy !== null}>
            {busy === 'verify' ? 'Проверяем...' : 'Подтвердить код'}
          </Button>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full whitespace-normal"
              disabled={busy !== null || retrySeconds > 0}
              onClick={requestCode}
            >
              {retrySeconds > 0 ? `Отправить ещё раз через ${retrySeconds} с` : 'Отправить ещё раз'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full"
              disabled={busy !== null}
              onClick={changeEmail}
            >
              Изменить email
            </Button>
          </div>
        </form>
      )}

      <Turnstile
        key={captchaVersion}
        ref={turnstileRef}
        onToken={(token) => {
          if (!token) return;
          const pending = pendingCaptchaSubmitRef.current;
          pendingCaptchaSubmitRef.current = null;
          pending?.(token);
        }}
      />
      <FieldError id={`${intent}-captcha-error`} message={fieldErrors.captcha} />

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <p className="text-center text-sm text-[var(--color-text-muted)]">
        {isRegister ? 'Уже есть аккаунт? ' : 'Нет аккаунта? '}
        <Link href={isRegister ? '/auth/login' : '/auth/register'} className="font-medium text-[var(--color-primary)] hover:underline">
          {isRegister ? 'Войти' : 'Регистрация'}
        </Link>
      </p>
    </>
  );
}
