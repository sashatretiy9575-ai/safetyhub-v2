'use client';

import { useEffect, useRef, useState } from 'react';
import { SignIn } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { FieldError } from '@/features/auth/form-controls';
import {
  formatRetryDelay,
  isOtpRateLimited,
  normalizeOtpRetryAfter,
  retrySecondsUntil,
} from '@/features/auth/otp-rate-limit';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { emailOtpStartSchema, emailOtpVerifySchema } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import { localizePathname, type AppLocale } from '@/i18n/config';

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
type FieldErrors = Partial<Record<'email' | 'code' | 'captcha' | 'legal', string>>;

const ATTEMPT_TTL_MS = 60 * 60 * 1000;
const RESEND_DELAY_SECONDS = 60;
const ATTEMPT_STORAGE_KEY = 'safetyhub-email-otp:attempt';
const SEND_COOLDOWN_STORAGE_KEY = 'safetyhub-email-otp:send-cooldown';
const SEND_RATE_LIMITED_ERROR = 'SEND_RATE_LIMITED';
const VERIFY_RATE_LIMITED_ERROR = 'VERIFY_RATE_LIMITED';

function readStoredAttempt(): StoredAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<StoredAttempt>;
    const parsedEmail = emailOtpStartSchema.safeParse({ email: candidate.email });
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

function readStoredSendCooldown(): StoredCooldown | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(SEND_COOLDOWN_STORAGE_KEY) ?? 'null',
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<StoredCooldown>;
    const parsedEmail = emailOtpStartSchema.safeParse({ email: candidate.email });
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

function safeLanding(value: unknown, locale: AppLocale) {
  if (typeof window !== 'undefined') {
    const returnUrl = new URLSearchParams(window.location.search).get('return');
    if (
      returnUrl &&
      !returnUrl.startsWith('//') &&
      returnUrl.startsWith('/') &&
      (returnUrl.startsWith('/topics/') || returnUrl.startsWith(`/${locale}/topics/`))
    ) {
      if (value === localizePathname('/profile', locale) || value === '/profile') {
        return returnUrl;
      }
    }
  }

  return value === '/admin' ||
    value === localizePathname('/auth/legal', locale) ||
    value === localizePathname('/onboarding', locale) ||
    value === localizePathname('/profile', locale)
    ? value
    : localizePathname('/profile', locale);
}

export function EmailOtpFlow() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('AuthOtp');
  const legalT = useTranslations('LegalFlow');
  const errorT = useTranslations('Common.errors');
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
  // The sentence next to the box says that continuing is the acceptance, so the
  // box starts ticked and stays clearable instead of blocking the button by
  // default. Nothing about it is persisted; the server records the acceptance
  // per verification. The ZH flow already starts from the same default.
  const [legalAccepted, setLegalAccepted] = useState(true);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const inFlightActionRef = useRef<BusyAction>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const latestRetryAt = Math.max(sendRetryAt, verifyRetryAt);
  const sendRetrySeconds = retrySecondsUntil(sendRetryAt, retryClock);
  const verifyRetrySeconds = retrySecondsUntil(verifyRetryAt, retryClock);
  const retryActive = latestRetryAt > retryClock;

  useEffect(() => {
    const storedAttempt = readStoredAttempt();
    const storedCooldown = readStoredSendCooldown();
    if (!storedAttempt && !storedCooldown) return;

    setEmail(storedAttempt?.email ?? storedCooldown!.email);
    const attemptRetryAt = storedAttempt ? storedAttempt.sentAt + RESEND_DELAY_SECONDS * 1000 : 0;
    const retryAt = Math.max(attemptRetryAt, storedCooldown?.retryAt ?? 0);
    setSendRetryAt(retryAt);
    setRetryClock(Date.now());
    if (storedAttempt) {
      setSentAt(storedAttempt.sentAt);
      setStage('code');
      setStatus(t('storedStatus'));
    }
  }, [t]);

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
          captchaToken,
          locale,
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
        const localizedCodeMessage =
          errorCode === 'CAPTCHA_FAILED'
            ? t('captchaFailed')
            : errorCode === 'INVALID_REQUEST'
              ? t('requestInvalid')
              : errorCode === 'OTP_UNAVAILABLE'
                ? t('sendUnavailable')
                : null;
        const fallbackMessage = result.ok
          ? t('sendUnavailable')
          : localizedClientRequestMessage(result.error, t('sendUnavailable'), errorT);
        setError(localizedCodeMessage || fallbackMessage);
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
      setStatus(t('sentStatus'));
      storeAttempt(normalizedEmail, nextSentAt);
      storeSendCooldown(normalizedEmail, nextRetryAt);
    } catch (requestError) {
      setError(localizedClientRequestMessage(requestError, t('sendUnavailable'), errorT));
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
    });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.email?.length) nextErrors.email = t('emailInvalid');
      setFieldErrors(nextErrors);
      setError('');
      requestAnimationFrame(() => emailRef.current?.focus());
      return;
    }

    if (captchaRequired) {
      setBusy('send');
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
      locale,
      legalAccepted,
    });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.email?.length) nextErrors.email = t('emailInvalid');
      if (flattened.code?.length) nextErrors.code = t('codeInvalid');
      if (flattened.legalAccepted?.length) nextErrors.legal = t('legalRequired');
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
        const localizedCodeMessage =
          errorCode === 'OTP_CODE_INVALID'
            ? t('otpInvalid')
            : errorCode === 'INVALID_REQUEST'
              ? t('verifyInvalid')
              : errorCode === 'OTP_UNAVAILABLE'
                ? t('verifyUnavailable')
                : errorCode === 'AUTH_CONTEXT_UNAVAILABLE'
                  ? t('contextUnavailable')
                  : null;
        const fallbackMessage = result.ok
          ? t('verifyUnavailable')
          : localizedClientRequestMessage(result.error, t('verifyUnavailable'), errorT);
        setError(localizedCodeMessage || fallbackMessage);
        if (errorCode === 'OTP_CODE_INVALID') {
          setCode('');
          requestAnimationFrame(() => codeRef.current?.focus());
        }
        return;
      }

      clearStoredAttempt();
      clearStoredSendCooldown();
      router.replace(safeLanding(payload?.redirectTo, locale));
      router.refresh();
    } catch (requestError) {
      setError(localizedClientRequestMessage(requestError, t('verifyUnavailable'), errorT));
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

  const Icon = SignIn;
  const title = t('loginTitle');
  const visibleError =
    error === SEND_RATE_LIMITED_ERROR
      ? sendRetrySeconds > 0
        ? t('sendLimit', { delay: formatRetryDelay(sendRetrySeconds, locale) })
        : t('sendLimitExpired')
      : error === VERIFY_RATE_LIMITED_ERROR
        ? verifyRetrySeconds > 0
          ? t('verifyLimit', { delay: formatRetryDelay(verifyRetrySeconds, locale) })
          : t('verifyLimitExpired')
        : error;

  const captchaWidget = (
    <>
      <Turnstile
        key={captchaVersion}
        ref={turnstileRef}
        onToken={(token) => {
          if (!token) return;
          const pending = pendingCaptchaSubmitRef.current;
          pendingCaptchaSubmitRef.current = null;
          pending?.(token);
        }}
        onFailure={() => {
          pendingCaptchaSubmitRef.current = null;
          setBusy(null);
          setError(t('captchaFailed'));
          setCaptchaVersion((value) => value + 1);
        }}
      />
      <FieldError id="email-otp-captcha-error" message={fieldErrors.captcha} />
    </>
  );

  return (
    <>
      <div className="space-y-2 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <Icon size={24} />
        </span>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {stage === 'email' ? t('emailDescription') : t('codeDescription')}
        </p>
      </div>

      {status && (
        <p role="status" className="rounded-xl bg-[var(--color-primary-soft)] p-4 text-sm">
          {status}
        </p>
      )}

      {visibleError && (
        <p
          role="alert"
          aria-live="assertive"
          className="rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 p-3 text-sm font-medium text-[var(--color-danger)]"
        >
          {visibleError}
        </p>
      )}

      {stage === 'email' && (
        <form onSubmit={requestCode} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email-otp-email">{t('emailLabel')}</Label>
            <Input
              id="email-otp-email"
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((value) => ({ ...value, email: undefined }));
              }}
              invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'email-otp-email-error' : undefined}
              required
            />
            <FieldError id="email-otp-email-error" message={fieldErrors.email} />
          </div>

          {captchaWidget}

          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={busy !== null || sendRetrySeconds > 0}
          >
            {busy === 'send'
              ? t('sending')
              : sendRetrySeconds > 0
                ? t('retryIn', { delay: formatRetryDelay(sendRetrySeconds, locale) })
                : t('send')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            disabled={busy !== null}
            onClick={() => {
              setStage('code');
              setStatus(t('existingStatus'));
              setError('');
            }}
          >
            {t('haveCode')}
          </Button>
        </form>
      )}

      {stage === 'code' && (
        <form onSubmit={verifyCode} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email-otp-code-email">{t('emailLabel')}</Label>
            <Input
              id="email-otp-code-email"
              ref={emailRef}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                const nextEmail = event.target.value;
                setEmail(nextEmail);
                const parsed = emailOtpStartSchema.safeParse({ email: nextEmail });
                if (sentAt > 0 && parsed.success) storeAttempt(parsed.data.email, sentAt);
                setFieldErrors((value) => ({ ...value, email: undefined }));
              }}
              invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'email-otp-code-email-error' : undefined}
              required
            />
            <FieldError id="email-otp-code-email-error" message={fieldErrors.email} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email-otp-code">{t('codeLabel')}</Label>
            <Input
              id="email-otp-code"
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
              aria-describedby={fieldErrors.code ? 'email-otp-code-error' : undefined}
              required
            />
            <FieldError id="email-otp-code-error" message={fieldErrors.code} />
          </div>
          <div className="space-y-1">
            <label
              className="flex items-start gap-2 text-xs leading-5 text-[var(--color-text-muted)]"
              htmlFor="email-otp-legal"
            >
              <input
                id="email-otp-legal"
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 rounded border-[var(--color-border-strong)] accent-[var(--color-primary)]"
                checked={legalAccepted}
                onChange={(event) => {
                  setLegalAccepted(event.target.checked);
                  setFieldErrors((current) => ({ ...current, legal: undefined }));
                }}
                disabled={busy !== null}
                aria-describedby={fieldErrors.legal ? 'email-otp-legal-error' : undefined}
              />
              <span>
                {t('legalPrefix')}{' '}
                <a
                  className="underline underline-offset-4"
                  href={localizePathname('/terms', locale)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {legalT('terms')}
                </a>{' '}
                {t('legalAnd')}{' '}
                <a
                  className="underline underline-offset-4"
                  href={localizePathname('/privacy', locale)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {legalT('privacy')}
                </a>
                .
              </span>
            </label>
            {fieldErrors.legal ? (
              <p id="email-otp-legal-error" role="alert" className="text-xs text-[var(--color-danger)]">
                {t('legalRequired')}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={busy !== null || verifyRetrySeconds > 0 || !legalAccepted}
          >
            {busy === 'verify'
              ? t('verifying')
              : verifyRetrySeconds > 0
                ? t('retryIn', { delay: formatRetryDelay(verifyRetrySeconds, locale) })
                : t('verify')}
          </Button>
          {captchaWidget}
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full whitespace-normal"
              disabled={busy !== null || sendRetrySeconds > 0}
              onClick={requestCode}
            >
              {sendRetrySeconds > 0
                ? t('resendIn', { delay: formatRetryDelay(sendRetrySeconds, locale) })
                : t('resend')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full"
              disabled={busy !== null}
              onClick={changeEmail}
            >
              {t('changeEmail')}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
