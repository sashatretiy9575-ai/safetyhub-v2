'use client';

import { useEffect, useRef, useState } from 'react';
import { SignIn, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FieldError } from '@/features/auth/form-controls';
import {
  formatRetryDelay,
  isOtpRateLimited,
  normalizeOtpRetryAfter,
  retrySecondsUntil,
} from '@/features/auth/otp-rate-limit';
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
  sentAt: number;
};
type StoredCooldown = {
  email: string;
  retryAt: number;
};
type FieldErrors = Partial<Record<'email' | 'code' | 'captcha', string>>;

const ATTEMPT_TTL_MS = 60 * 60 * 1000;
const RESEND_DELAY_SECONDS = 60;
const ATTEMPT_STORAGE_KEY = 'safetyhub-email-otp:attempt';
const SEND_COOLDOWN_STORAGE_KEY = 'safetyhub-email-otp:send-cooldown';
const SEND_RATE_LIMITED_ERROR = 'SEND_RATE_LIMITED';
const VERIFY_RATE_LIMITED_ERROR = 'VERIFY_RATE_LIMITED';

const sendErrorMessages: Record<string, string> = {
  CAPTCHA_FAILED: 'Проверка безопасности истекла. Пройдите её снова.',
  INVALID_REQUEST: 'Проверьте введённый email.',
  OTP_UNAVAILABLE: 'Не удалось отправить код. Повторите позже.',
};

const verifyErrorMessages: Record<string, string> = {
  OTP_CODE_INVALID: 'Код неверен, истёк или уже использован. Проверьте его либо запросите новый.',
  INVALID_REQUEST: 'Введите email и шестизначный код.',
  OTP_UNAVAILABLE: 'Не удалось проверить код. Повторите позже.',
  AUTH_CONTEXT_UNAVAILABLE: 'Сессия подтверждена, но профиль пока недоступен. Повторите позже.',
};

function readStoredAttempt(intent: EmailOtpIntent): StoredAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<StoredAttempt>;
    const parsedEmail = emailOtpStartSchema.safeParse({
      email: candidate.email,
      intent,
    });
    if (
      !parsedEmail.success ||
      typeof candidate.sentAt !== 'number' ||
      candidate.sentAt > Date.now() ||
      Date.now() - candidate.sentAt > ATTEMPT_TTL_MS
    ) {
      sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
      return null;
    }
    return {
      email: parsedEmail.data.email,
      sentAt: candidate.sentAt,
    };
  } catch {
    return null;
  }
}

function storeAttempt(email: string, sentAt: number) {
  try {
    sessionStorage.setItem(
      ATTEMPT_STORAGE_KEY,
      JSON.stringify({
        email,
        sentAt,
      } satisfies StoredAttempt),
    );
  } catch {
    // A storage-denied browser can still complete the flow while the page stays open.
  }
}

function clearStoredAttempt() {
  try {
    sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
  } catch {
    // Nothing client-side is authoritative for an OTP session.
  }
}

function readStoredSendCooldown(intent: EmailOtpIntent): StoredCooldown | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(SEND_COOLDOWN_STORAGE_KEY) ?? 'null',
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<StoredCooldown>;
    const parsedEmail = emailOtpStartSchema.safeParse({ email: candidate.email, intent });
    if (
      !parsedEmail.success ||
      typeof candidate.retryAt !== 'number' ||
      candidate.retryAt <= Date.now() ||
      candidate.retryAt - Date.now() > ATTEMPT_TTL_MS
    ) {
      sessionStorage.removeItem(SEND_COOLDOWN_STORAGE_KEY);
      return null;
    }
    return { email: parsedEmail.data.email, retryAt: candidate.retryAt };
  } catch {
    return null;
  }
}

function storeSendCooldown(email: string, retryAt: number) {
  try {
    sessionStorage.setItem(
      SEND_COOLDOWN_STORAGE_KEY,
      JSON.stringify({
        email,
        retryAt,
      } satisfies StoredCooldown),
    );
  } catch {
    // A storage-denied browser still keeps the in-memory countdown.
  }
}

function clearStoredSendCooldown() {
  try {
    sessionStorage.removeItem(SEND_COOLDOWN_STORAGE_KEY);
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
  const [sendRetryAt, setSendRetryAt] = useState(0);
  const [verifyRetryAt, setVerifyRetryAt] = useState(0);
  const [retryClock, setRetryClock] = useState(0);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const inFlightActionRef = useRef<BusyAction>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const isRegister = intent === 'register';
  const latestRetryAt = Math.max(sendRetryAt, verifyRetryAt);
  const sendRetrySeconds = retrySecondsUntil(sendRetryAt, retryClock);
  const verifyRetrySeconds = retrySecondsUntil(verifyRetryAt, retryClock);
  const retryActive = latestRetryAt > retryClock;

  useEffect(() => {
    const storedAttempt = readStoredAttempt(intent);
    const storedCooldown = readStoredSendCooldown(intent);
    if (!storedAttempt && !storedCooldown) return;

    setEmail(storedAttempt?.email ?? storedCooldown!.email);
    const attemptRetryAt = storedAttempt ? storedAttempt.sentAt + RESEND_DELAY_SECONDS * 1000 : 0;
    const retryAt = Math.max(attemptRetryAt, storedCooldown?.retryAt ?? 0);
    setSendRetryAt(retryAt);
    setRetryClock(Date.now());
    if (storedAttempt) {
      setSentAt(storedAttempt.sentAt);
      setStage('code');
      setStatus('Введите код из письма. Если письмо не пришло, запросите новый код.');
    }
  }, [intent]);

  useEffect(() => {
    if (!retryActive) return;
    const syncClock = () => setRetryClock(Date.now());
    syncClock();
    const timer = window.setInterval(syncClock, 1000);
    document.addEventListener('visibilitychange', syncClock);
    window.addEventListener('pageshow', syncClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', syncClock);
      window.removeEventListener('pageshow', syncClock);
    };
  }, [latestRetryAt, retryActive]);

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
    if (inFlightActionRef.current) return;
    inFlightActionRef.current = 'send';
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
      const payload = await readClientResponseJson<{
        sent?: unknown;
        error?: unknown;
        retryAfter?: unknown;
      }>(result.response);
      if (!result.ok || payload?.sent !== true) {
        const errorCode = typeof payload?.error === 'string' ? payload.error : null;
        if (isOtpRateLimited(errorCode, result.response?.status)) {
          const retryAfter = normalizeOtpRetryAfter(
            payload?.retryAfter,
            result.response?.headers.get('Retry-After') ?? null,
          );
          const retryAt = Date.now() + retryAfter * 1000;
          setSendRetryAt(retryAt);
          setRetryClock(Date.now());
          storeSendCooldown(normalizedEmail, retryAt);
          setError(SEND_RATE_LIMITED_ERROR);
          return;
        }
        const fallbackMessage = result.ok
          ? 'Не удалось отправить код. Повторите позже.'
          : clientRequestMessage(result.error, 'Не удалось отправить код. Повторите позже.');
        setError((errorCode && sendErrorMessages[errorCode]) || fallbackMessage);
        return;
      }

      const nextSentAt = Date.now();
      const nextRetryAt = nextSentAt + RESEND_DELAY_SECONDS * 1000;
      setEmail(normalizedEmail);
      setCode('');
      setSentAt(nextSentAt);
      setSendRetryAt(nextRetryAt);
      setRetryClock(nextSentAt);
      setStage('code');
      setStatus('Если этот адрес можно использовать, код отправлен. Введите шесть цифр из письма.');
      storeAttempt(normalizedEmail, nextSentAt);
      storeSendCooldown(normalizedEmail, nextRetryAt);
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось отправить код. Повторите позже.'));
    } finally {
      resetCaptcha();
      inFlightActionRef.current = null;
      setBusy(null);
    }
  };

  const requestCode = (event?: React.FormEvent | React.MouseEvent) => {
    event?.preventDefault();
    if (
      busy ||
      inFlightActionRef.current ||
      pendingCaptchaSubmitRef.current ||
      sendRetrySeconds > 0
    )
      return;
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
    if (busy || inFlightActionRef.current || verifyRetrySeconds > 0) return;
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

    inFlightActionRef.current = 'verify';
    setBusy('verify');
    setError('');
    setFieldErrors({});
    try {
      const result = await clientRequest('/api/auth/email-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const payload = await readClientResponseJson<{
        verified?: unknown;
        redirectTo?: unknown;
        error?: unknown;
        retryAfter?: unknown;
      }>(result.response);
      if (!result.ok || payload?.verified !== true) {
        const errorCode = typeof payload?.error === 'string' ? payload.error : null;
        if (isOtpRateLimited(errorCode, result.response?.status)) {
          const retryAfter = normalizeOtpRetryAfter(
            payload?.retryAfter,
            result.response?.headers.get('Retry-After') ?? null,
          );
          const retryAt = Date.now() + retryAfter * 1000;
          setVerifyRetryAt(retryAt);
          setRetryClock(Date.now());
          setError(VERIFY_RATE_LIMITED_ERROR);
          return;
        }
        const fallbackMessage = result.ok
          ? 'Не удалось проверить код. Повторите позже.'
          : clientRequestMessage(result.error, 'Не удалось проверить код. Повторите позже.');
        setError((errorCode && verifyErrorMessages[errorCode]) || fallbackMessage);
        if (errorCode === 'OTP_CODE_INVALID') {
          setCode('');
          requestAnimationFrame(() => codeRef.current?.focus());
        }
        return;
      }

      clearStoredAttempt();
      clearStoredSendCooldown();
      router.replace(safeLanding(payload?.redirectTo));
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось проверить код. Повторите позже.'));
    } finally {
      inFlightActionRef.current = null;
      setBusy(null);
    }
  };

  const changeEmail = () => {
    clearStoredAttempt();
    setStage('email');
    setCode('');
    setSentAt(0);
    setVerifyRetryAt(0);
    setError('');
    setStatus('');
    setFieldErrors({});
  };

  const Icon = isRegister ? UserPlus : SignIn;
  const title = isRegister ? 'Создать аккаунт' : 'Вход или регистрация';
  const visibleError =
    error === SEND_RATE_LIMITED_ERROR
      ? sendRetrySeconds > 0
        ? `Лимит отправки кода исчерпан. Повторите через ${formatRetryDelay(sendRetrySeconds)}.`
        : 'Время ожидания истекло. Теперь можно запросить новый код.'
      : error === VERIFY_RATE_LIMITED_ERROR
        ? verifyRetrySeconds > 0
          ? `Слишком много попыток проверки. Повторите через ${formatRetryDelay(verifyRetrySeconds)}.`
          : 'Время ожидания истекло. Теперь можно снова проверить код.'
        : error;

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

          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={busy !== null || sendRetrySeconds > 0}
          >
            {busy === 'send'
              ? 'Отправляем...'
              : sendRetrySeconds > 0
                ? `Повторить через ${formatRetryDelay(sendRetrySeconds)}`
                : 'Получить код'}
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
                if (sentAt > 0 && parsed.success) storeAttempt(parsed.data.email, sentAt);
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
          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={busy !== null || verifyRetrySeconds > 0}
          >
            {busy === 'verify'
              ? 'Проверяем...'
              : verifyRetrySeconds > 0
                ? `Повторить через ${formatRetryDelay(verifyRetrySeconds)}`
                : 'Подтвердить код'}
          </Button>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full whitespace-normal"
              disabled={busy !== null || sendRetrySeconds > 0}
              onClick={requestCode}
            >
              {sendRetrySeconds > 0
                ? `Отправить ещё раз через ${formatRetryDelay(sendRetrySeconds)}`
                : 'Отправить ещё раз'}
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

      {visibleError && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {visibleError}
        </p>
      )}

      <p className="text-center text-sm text-[var(--color-text-muted)]">
        {isRegister ? 'Уже есть аккаунт? ' : 'Нет аккаунта? '}
        <Link
          href={isRegister ? '/auth/login' : '/auth/register'}
          className="font-medium text-[var(--color-primary)] hover:underline"
        >
          {isRegister ? 'Войти' : 'Регистрация'}
        </Link>
      </p>
    </>
  );
}
