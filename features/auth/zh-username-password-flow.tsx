'use client';

import { SignIn, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError } from '@/features/auth/form-controls';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import {
  zhUsernamePasswordLoginSchema,
  zhUsernamePasswordRegistrationSchema,
  ZH_PASSWORD_MAX_BYTES,
} from '@/features/auth/zh-username-password-validation';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { safeReturnPath } from '@/lib/security/redirect';

type Mode = 'login' | 'register';
type AuthResponse = {
  verified?: unknown;
  registered?: unknown;
  redirectTo?: unknown;
  error?: unknown;
};
type Fields = {
  username: string;
  password: string;
  passwordConfirmation: string;
  legalAccepted: boolean;
};
type FieldErrors = Partial<Record<keyof Fields, string>>;

/** The subset of AuthZh that field validation needs. */
type ValidationCopy = (
  key: 'usernameInvalid' | 'passwordInvalid' | 'passwordConfirmationInvalid' | 'legalRequired',
) => string;

function safeLanding(value: unknown) {
  if (typeof window !== 'undefined') {
    // Mirrors the email-code realm: a ?return= target is honoured only for the
    // workspace the server authorized, and only through the shared validator.
    const requested = new URLSearchParams(window.location.search).get('return');
    const isAdminLanding = value === '/admin';
    const returnPath = safeReturnPath(requested, isAdminLanding ? 'admin' : 'account');
    if (returnPath && (isAdminLanding || value === '/zh/profile')) return returnPath;
  }

  return value === '/admin' ||
    value === '/zh/auth/legal' ||
    value === '/zh/onboarding' ||
    value === '/zh/profile'
    ? value
    : '/zh/profile';
}

function validationErrors(mode: Mode, fields: Fields, copy: ValidationCopy): FieldErrors {
  const parsed =
    mode === 'login'
      ? zhUsernamePasswordLoginSchema.safeParse(fields)
      : zhUsernamePasswordRegistrationSchema.safeParse(fields);
  if (parsed.success) return {};

  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'username') {
      errors.username = copy('usernameInvalid');
    } else if (field === 'password') {
      errors.password = copy('passwordInvalid');
    } else if (field === 'passwordConfirmation') {
      errors.passwordConfirmation = copy('passwordConfirmationInvalid');
    } else if (field === 'legalAccepted') {
      errors.legalAccepted = copy('legalRequired');
    }
  }
  return errors;
}

export function ZhUsernamePasswordFlow() {
  const t = useTranslations('AuthZh');
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const isRegistration = mode === 'register';
  const [fields, setFields] = useState<Fields>({
    username: '',
    password: '',
    passwordConfirmation: '',
    legalAccepted: true,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'error' | 'status'>('error');
  const [busy, setBusy] = useState(false);
  const [autoLoginPending, setAutoLoginPending] = useState(false);
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const submitRequestRef = useRef<(captchaToken?: string, requestedMode?: Mode) => void>(
    () => undefined,
  );
  const autoLoginPendingRef = useRef(false);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  // Two messages are built once because they are reused by the CAPTCHA
  // recovery path below, which the Turnstile lifecycle test reads by name.
  const REGISTRATION_COMPLETE = t('registrationComplete');
  const AUTO_LOGIN_FALLBACK = t('autoLoginFallback', { complete: REGISTRATION_COMPLETE });
  const CAPTCHA_RETRY = t('captchaRetry');

  const setAutomaticLoginPending = useCallback((pending: boolean) => {
    autoLoginPendingRef.current = pending;
    setAutoLoginPending(pending);
  }, []);

  const setField = <Field extends keyof Fields>(field: Field, value: Fields[Field]) => {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setMessage('');
  };

  const resetCaptcha = useCallback(() => {
    pendingCaptchaSubmitRef.current = null;
  }, []);

  const submitRequest = useCallback(async (captchaToken?: string, requestedMode: Mode = mode) => {
    let automaticLoginStarted = false;
    setBusy(true);
    setMessage('');
    try {
      const registering = requestedMode === 'register';
      const body = registering
        ? {
            username: fields.username,
            password: fields.password,
            passwordConfirmation: fields.passwordConfirmation,
            legalAccepted: fields.legalAccepted,
            captchaToken,
          }
        : { username: fields.username, password: fields.password, captchaToken };
      const result = await clientRequest(
        registering ? '/api/auth/zh/register' : '/api/auth/zh/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = await readClientResponseJson<AuthResponse>(result.response);
      if (registering && result.ok && payload?.registered === true) {
        if (payload?.verified === true) {
          router.replace(safeLanding(payload.redirectTo));
          router.refresh();
          return;
        }

        // Registration proof is single-use. Keep credentials only in this
        // component's memory, mint a fresh CAPTCHA proof, then use the normal
        // login endpoint. The server's verification requirements stay intact.
        automaticLoginStarted = true;
        setMode('login');
        setErrors({});
        setAutomaticLoginPending(true);
        setMessageKind('status');
        setMessage(t('autoLoginPending'));
        return;
      }
      if (!result.ok || payload?.verified !== true) {
        const unavailable = payload?.error === 'ZH_AUTH_UNAVAILABLE';
        setMessageKind('error');
        setMessage(
          unavailable
            ? t('unavailable')
            : registering
              ? t('registrationFailure')
              : t('loginFailure'),
        );
        return;
      }
      router.replace(safeLanding(payload.redirectTo));
      router.refresh();
    } catch {
      setMessageKind('error');
      setMessage(t('unavailable'));
    } finally {
      if (!automaticLoginStarted) resetCaptcha();
      setBusy(false);
    }
  }, [fields, mode, resetCaptcha, router, setAutomaticLoginPending, t]);

  // Effects and the Turnstile callback need the latest submission closure, but
  // mutating a ref during render is not React-safe under concurrent rendering.
  useEffect(() => {
    submitRequestRef.current = (captchaToken, requestedMode) => {
      void submitRequest(captchaToken, requestedMode);
    };
  }, [submitRequest]);

  useEffect(() => {
    if (!autoLoginPending) return;

    if (captchaRequired) {
      if (pendingCaptchaSubmitRef.current) return;
      pendingCaptchaSubmitRef.current = (freshToken) => {
        setAutomaticLoginPending(false);
        submitRequestRef.current(freshToken, 'login');
      };
      turnstileRef.current?.execute();
      return;
    }

    const timer = window.setTimeout(() => {
      setAutomaticLoginPending(false);
      submitRequestRef.current(undefined, 'login');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoLoginPending, captchaRequired, setAutomaticLoginPending]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || autoLoginPending || pendingCaptchaSubmitRef.current) return;
    const nextErrors = validationErrors(mode, fields, t);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    if (captchaRequired) {
      const requestedMode = mode;
      pendingCaptchaSubmitRef.current = (token) => void submitRequest(token, requestedMode);
      setMessage('');
      turnstileRef.current?.execute();
      return;
    }
    void submitRequest(undefined, mode);
  };

  const chooseMode = (nextMode: Mode) => {
    if (busy || autoLoginPending || nextMode === mode) return;
    setMode(nextMode);
    setErrors({});
    setMessage('');
  };

  const Icon = isRegistration ? UserPlus : SignIn;

  return (
    <>
      <div className="space-y-2 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <Icon size={24} />
        </span>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">{t('description')}</p>
      </div>

      <div
        role="group"
        aria-label={t('modeGroup')}
        className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-1"
      >
        <button
          type="button"
          aria-pressed={!isRegistration}
          disabled={busy || autoLoginPending}
          onClick={() => chooseMode('login')}
          className={`min-h-10 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-semibold transition-colors ${!isRegistration ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
        >
          {t('login')}
        </button>
        <button
          type="button"
          aria-pressed={isRegistration}
          disabled={busy || autoLoginPending}
          onClick={() => chooseMode('register')}
          className={`min-h-10 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-semibold transition-colors ${isRegistration ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
        >
          {t('register')}
        </button>
      </div>

      <form className="space-y-4" noValidate onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor={`zh-${mode}-username`}>{t('usernameLabel')}</Label>
          <Input
            id={`zh-${mode}-username`}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={32}
            value={fields.username}
            onChange={(event) => setField('username', event.target.value)}
            disabled={busy || autoLoginPending}
            invalid={Boolean(errors.username)}
            aria-describedby={errors.username ? `zh-${mode}-username-error` : 'zh-username-help'}
            required
          />
          <p id="zh-username-help" className="text-xs text-[var(--color-text-muted)]">
            {t('usernameHint')}
          </p>
          <FieldError id={`zh-${mode}-username-error`} message={errors.username} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`zh-${mode}-password`}>{t('passwordLabel')}</Label>
          <Input
            id={`zh-${mode}-password`}
            type="password"
            autoComplete={isRegistration ? 'new-password' : 'current-password'}
            maxLength={ZH_PASSWORD_MAX_BYTES}
            value={fields.password}
            onChange={(event) => setField('password', event.target.value)}
            disabled={busy || autoLoginPending}
            invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? `zh-${mode}-password-error` : undefined}
            required
          />
          <FieldError id={`zh-${mode}-password-error`} message={errors.password} />
          {isRegistration ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('passwordHint')}
            </p>
          ) : null}
        </div>

        {isRegistration ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="zh-register-password-confirmation">
                {t('passwordConfirmationLabel')}
              </Label>
              <Input
                id="zh-register-password-confirmation"
                type="password"
                autoComplete="new-password"
                maxLength={ZH_PASSWORD_MAX_BYTES}
                value={fields.passwordConfirmation}
                onChange={(event) => setField('passwordConfirmation', event.target.value)}
                disabled={busy || autoLoginPending}
                invalid={Boolean(errors.passwordConfirmation)}
                aria-describedby={
                  errors.passwordConfirmation
                    ? 'zh-register-password-confirmation-error'
                    : undefined
                }
                required
              />
              <FieldError
                id="zh-register-password-confirmation-error"
                message={errors.passwordConfirmation}
              />
            </div>

            <div className="space-y-1">
              <label
                className="flex items-start gap-2 text-xs leading-5 text-[var(--color-text-muted)]"
                htmlFor="zh-register-legal"
              >
                <input
                  id="zh-register-legal"
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 rounded border-[var(--color-border-strong)] accent-[var(--color-primary)]"
                  checked={fields.legalAccepted}
                  onChange={(event) => setField('legalAccepted', event.target.checked)}
                  disabled={busy || autoLoginPending}
                  aria-describedby={errors.legalAccepted ? 'zh-register-legal-error' : undefined}
                />
                <span>
                  {t('legalPrefix')}{' '}
                  <Link className="underline underline-offset-4" href="/zh/terms">
                    {t('legalTerms')}
                  </Link>{' '}
                  {t('legalAnd')}{' '}
                  <Link className="underline underline-offset-4" href="/zh/privacy">
                    {t('legalPrivacy')}
                  </Link>
                  {t('legalSuffix')}
                </span>
              </label>
              <FieldError id="zh-register-legal-error" message={errors.legalAccepted} />
            </div>
          </>
        ) : null}

        <Button className="min-h-11 w-full" type="submit" disabled={busy || autoLoginPending}>
          {busy || autoLoginPending
            ? t('submitBusy')
            : isRegistration
              ? t('submitRegister')
              : t('submitLogin')}
        </Button>
      </form>

      <Turnstile
        key={captchaVersion}
        ref={turnstileRef}
        onToken={(token) => {
          if (!token) return;
          const pending = pendingCaptchaSubmitRef.current;
          pendingCaptchaSubmitRef.current = null;
          setAutomaticLoginPending(false);
          pending?.(token);
        }}
        onFailure={() => {
          pendingCaptchaSubmitRef.current = null;
          const automaticLoginFailed = autoLoginPendingRef.current;
          setAutomaticLoginPending(false);
          setMode('login');
          setMessageKind('error');
          setMessage(automaticLoginFailed ? AUTO_LOGIN_FALLBACK : CAPTCHA_RETRY);
          setCaptchaVersion((value) => value + 1);
        }}
      />

      {message ? (
        <p
          role={messageKind === 'status' ? 'status' : 'alert'}
          aria-live={messageKind === 'status' ? 'polite' : 'assertive'}
          className={`text-sm ${messageKind === 'status' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'}`}
        >
          {message}
        </p>
      ) : null}

      {isRegistration ? (
        <p className="text-sm leading-6 text-[var(--color-text-muted)]">
          {t('registerHint')}
        </p>
      ) : (
        <p className="text-sm leading-6 text-[var(--color-text-muted)]">
          {t('loginHint')}
        </p>
      )}
    </>
  );
}
