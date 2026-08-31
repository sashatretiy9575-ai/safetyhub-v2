'use client';

import { useEffect, useRef, useState } from 'react';
import { Key } from '@phosphor-icons/react';
import Link from 'next/link';
import { PasswordChangeForm } from '@/features/auth/password-change-form';
import { FieldError } from '@/features/auth/form-controls';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { recoveryStartSchema, recoveryVerifySchema } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type RecoveryStage = 'email' | 'code' | 'password';
type BusyAction = 'send' | 'verify' | null;
type StoredAttempt = { email: string; stage: 'code'; sentAt: number };

const ATTEMPT_STORAGE_KEY = 'safetyhub-password-recovery-attempt';
const ATTEMPT_TTL_MS = 60 * 60 * 1000;
const RESEND_DELAY_SECONDS = 60;

const sendErrorMessages: Record<string, string> = {
  CAPTCHA_FAILED: 'Проверка безопасности истекла. Пройдите её снова.',
  RATE_LIMITED: 'Слишком много запросов. Попробуйте немного позже.',
  INVALID_REQUEST: 'Проверьте введённый email.',
  RECOVERY_UNAVAILABLE: 'Не удалось отправить код. Повторите позже.',
};

const verifyErrorMessages: Record<string, string> = {
  RECOVERY_CODE_INVALID: 'Код неверен или уже истёк. Проверьте код либо запросите новый.',
  RATE_LIMITED: 'Слишком много попыток. Попробуйте немного позже.',
  INVALID_REQUEST: 'Введите email и шестизначный код.',
  RECOVERY_UNAVAILABLE: 'Не удалось проверить код. Повторите позже.',
};

function readStoredAttempt(): StoredAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<StoredAttempt>;
    const parsedEmail = recoveryStartSchema.safeParse({ email: candidate.email });
    if (
      !parsedEmail.success ||
      candidate.stage !== 'code' ||
      typeof candidate.sentAt !== 'number' ||
      Date.now() - candidate.sentAt > ATTEMPT_TTL_MS
    ) {
      sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
      return null;
    }
    return {
      email: parsedEmail.data.email,
      stage: 'code',
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
      JSON.stringify({ email, stage: 'code', sentAt } satisfies StoredAttempt),
    );
  } catch {
    // A storage-denied browser can still complete the flow while this page stays open.
  }
}

function clearStoredAttempt() {
  try {
    sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
  } catch {
    // The server-held recovery context remains authoritative.
  }
}

export function PasswordRecoveryFlow({ initialVerified }: { initialVerified: boolean }) {
  const [stage, setStage] = useState<RecoveryStage>(initialVerified ? 'password' : 'email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentAt, setSentAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'email' | 'code', string>>>({});
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  useEffect(() => {
    if (initialVerified) {
      clearStoredAttempt();
      return;
    }
    const stored = readStoredAttempt();
    if (!stored) return;
    setEmail(stored.email);
    setSentAt(stored.sentAt);
    setRetrySeconds(
      Math.max(0, Math.ceil((stored.sentAt + RESEND_DELAY_SECONDS * 1000 - Date.now()) / 1000)),
    );
    setStage('code');
    setStatus('Введите код из письма. Если письмо не пришло, запросите новый код.');
  }, [initialVerified]);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const timer = window.setInterval(() => {
      setRetrySeconds((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retrySeconds]);

  useEffect(() => {
    if (stage === 'password') clearStoredAttempt();
    const hasEmail = recoveryStartSchema.safeParse({ email: emailRef.current?.value }).success;
    const target =
      stage === 'code'
        ? hasEmail
          ? codeRef.current
          : emailRef.current
        : stage === 'email'
          ? emailRef.current
          : null;
    if (target) requestAnimationFrame(() => target.focus());
  }, [stage]);

  const sendCode = async (normalizedEmail: string, captchaToken?: string) => {
    setBusy('send');
    setError('');
    setFieldErrors({});
    try {
      const result = await clientRequest('/api/auth/password/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, captchaToken }),
      });
      const payload = await readClientResponseJson<{ sent?: boolean; error?: string }>(
        result.response,
      );
      if (!result.ok || payload?.sent !== true) {
        const fallback = 'Не удалось отправить код. Повторите позже.';
        setError(
          (payload?.error && sendErrorMessages[payload.error]) ||
            (result.ok ? fallback : clientRequestMessage(result.error, fallback)),
        );
        return;
      }

      const nextSentAt = Date.now();
      setEmail(normalizedEmail);
      setCode('');
      setSentAt(nextSentAt);
      setRetrySeconds(RESEND_DELAY_SECONDS);
      setStage('code');
      setStatus('Если аккаунт существует, код отправлен на указанную почту.');
      storeAttempt(normalizedEmail, nextSentAt);
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось отправить код. Повторите позже.'));
    } finally {
      pendingCaptchaSubmitRef.current = null;
      setCaptchaVersion((value) => value + 1);
      setBusy(null);
    }
  };

  const requestCode = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || (stage === 'code' && retrySeconds > 0)) return;
    const parsed = recoveryStartSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldErrors({ email: 'Введите корректный email.' });
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
    const parsed = recoveryVerifySchema.safeParse({ email, code });
    if (!parsed.success) {
      const flattened = parsed.error.flatten().fieldErrors;
      const nextErrors: typeof fieldErrors = {};
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
      const result = await clientRequest('/api/auth/password/recovery/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const payload = await readClientResponseJson<{ verified?: boolean; error?: string }>(
        result.response,
      );
      if (!result.ok || payload?.verified !== true) {
        const fallback = 'Не удалось проверить код. Повторите позже.';
        setError(
          (payload?.error && verifyErrorMessages[payload.error]) ||
            (result.ok ? fallback : clientRequestMessage(result.error, fallback)),
        );
        if (payload?.error === 'RECOVERY_CODE_INVALID') {
          setCode('');
          requestAnimationFrame(() => codeRef.current?.focus());
        }
        return;
      }

      setCode('');
      setStatus('Код подтверждён. Придумайте новый пароль.');
      clearStoredAttempt();
      setStage('password');
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось проверить код. Повторите позже.'));
    } finally {
      setBusy(null);
    }
  };

  const changeEmail = () => {
    clearStoredAttempt();
    setStage('email');
    setCode('');
    setSentAt(0);
    setRetrySeconds(0);
    setError('');
    setStatus('');
    setFieldErrors({});
  };

  return (
    <>
      <div className="space-y-2 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <Key size={24} />
        </span>
        <h1 className="font-display text-2xl font-bold">
          {stage === 'password' ? 'Придумайте новый пароль' : 'Восстановить пароль'}
        </h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {stage === 'email'
            ? 'Пришлём шестизначный код на вашу почту.'
            : stage === 'code'
              ? 'Введите email и шестизначный код из письма.'
              : 'Подтверждение действует 15 минут и сработает только один раз.'}
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
            <Label htmlFor="recovery-email">Email</Label>
            <Input
              id="recovery-email"
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((value) => ({ ...value, email: undefined }));
              }}
              invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'recovery-email-error' : undefined}
              required
            />
            <FieldError id="recovery-email-error" message={fieldErrors.email} />
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
            <Label htmlFor="recovery-code-email">Email</Label>
            <Input
              id="recovery-code-email"
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                const nextEmail = event.target.value;
                setEmail(nextEmail);
                const parsed = recoveryStartSchema.safeParse({ email: nextEmail });
                if (sentAt > 0 && parsed.success) storeAttempt(parsed.data.email, sentAt);
                setFieldErrors((value) => ({ ...value, email: undefined }));
              }}
              invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'recovery-code-email-error' : undefined}
              required
            />
            <FieldError id="recovery-code-email-error" message={fieldErrors.email} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="recovery-code">Код из письма</Label>
            <Input
              id="recovery-code"
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
              aria-describedby={fieldErrors.code ? 'recovery-code-error' : undefined}
              required
            />
            <FieldError id="recovery-code-error" message={fieldErrors.code} />
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

      {stage !== 'password' && (
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
      )}

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {stage === 'password' ? (
        <PasswordChangeForm mode="recovery" />
      ) : (
        <p className="text-center text-sm">
          <Link href="/auth/login" className="text-[var(--color-primary)] hover:underline">
            Вернуться ко входу
          </Link>
        </p>
      )}
    </>
  );
}
