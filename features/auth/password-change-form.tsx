'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import {
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
  updatePasswordSchema,
} from '@/lib/validation/auth';
import { Turnstile, type TurnstileHandle } from '@/features/auth/turnstile';
import { FieldError, PasswordInput } from '@/features/auth/form-controls';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type PasswordMode = 'current' | 'recovery' | 'invite';
type SuccessPayload = {
  changed: true;
  sessionsRevoked: boolean;
  signedOut: boolean;
};

const errorMessages: Record<string, string> = {
  CURRENT_PASSWORD_INVALID: 'Текущий пароль неверен.',
  CURRENT_PASSWORD_UNAVAILABLE: 'Для этой учётной записи недоступна смена по паролю.',
  PASSWORD_CONTEXT_INVALID: 'Подтверждение восстановления уже использовано или устарело.',
  PASSWORD_CHANGE_REJECTED: 'Новый пароль отклонён. Выберите другой пароль.',
  CAPTCHA_FAILED: 'Проверка безопасности истекла. Пройдите её снова.',
  INVALID_REQUEST: 'Проверьте заполненные поля.',
  AUTH_UNAVAILABLE: 'Сервис входа временно недоступен. Повторите позже.',
  RATE_LIMITED: 'Слишком много запросов. Попробуйте немного позже.',
};

export function PasswordChangeForm({ mode }: { mode: PasswordMode }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<'currentPassword' | 'password' | 'confirm' | 'captcha', string>>
  >({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<SuccessPayload | null>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = updatePasswordSchema.safeParse({ password, passwordConfirm: confirm });
    const errors: typeof fieldErrors = {};
    if (!parsed.success) {
      const flattened = parsed.error.flatten().fieldErrors;
      if (flattened.password?.length) {
        errors.password = 'Минимум 12 символов: латинские заглавная, строчная буквы и цифра.';
      }
      if (flattened.passwordConfirm?.length) errors.confirm = 'Пароли должны совпадать.';
    }
    if (mode === 'current' && !currentPassword) {
      errors.currentPassword = 'Введите текущий пароль.';
    }
    if (!parsed.success || Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError('');
      const target = errors.currentPassword
        ? currentPasswordRef.current
        : errors.password
          ? passwordRef.current
          : errors.confirm
            ? confirmRef.current
            : null;
      requestAnimationFrame(() => target?.focus());
      return;
    }

    const submitRequest = async (verifiedToken?: string) => {
      setBusy(true);
      setError('');
      setFieldErrors({});
      try {
        const body =
          mode === 'current'
            ? {
                mode: 'current' as const,
                currentPassword,
                password: parsed.data.password,
                passwordConfirm: parsed.data.passwordConfirm,
                captchaToken: verifiedToken,
              }
            : {
                mode: 'context' as const,
                contextKind: mode,
                password: parsed.data.password,
                passwordConfirm: parsed.data.passwordConfirm,
              };
        const result = await clientRequest('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await readClientResponseJson<SuccessPayload | { error?: string }>(
          result.response,
        );
        if (!result.ok || !payload || !('changed' in payload)) {
          const code = payload && 'error' in payload ? payload.error : undefined;
          const fallback = 'Не удалось изменить пароль.';
          setError(
            (code && errorMessages[code]) ||
              (result.ok ? fallback : clientRequestMessage(result.error, fallback)),
          );
          if (mode === 'current') {
            setCaptchaToken(null);
            setCaptchaVersion((value) => value + 1);
          }
          return;
        }
        setCurrentPassword('');
        setPassword('');
        setConfirm('');
        setCaptchaToken(null);
        setSuccess(payload);
      } catch (requestError) {
        setError(clientRequestMessage(requestError, 'Не удалось изменить пароль.'));
        if (mode === 'current') {
          setCaptchaToken(null);
          setCaptchaVersion((value) => value + 1);
        }
      } finally {
        setBusy(false);
      }
    };

    if (mode === 'current' && captchaRequired && !captchaToken) {
      pendingCaptchaSubmitRef.current = (token) => void submitRequest(token);
      setFieldErrors({});
      setError('');
      turnstileRef.current?.execute();
      return;
    }

    await submitRequest(captchaToken ?? undefined);
  };

  const signOutEverywhere = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'global' }),
      });
      if (!result.ok) {
        setError(
          clientRequestMessage(result.error, 'Не удалось завершить сеансы. Повторите позже.'),
        );
        return;
      }
      window.location.replace('/auth/login?signedOut=1');
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось завершить сеансы. Повторите позже.'));
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-xl bg-[var(--color-primary-soft)] p-4 text-sm">
          Пароль изменён.
          {success.sessionsRevoked
            ? ' Остальные сеансы завершены.'
            : ' Не удалось подтвердить завершение остальных сеансов.'}
        </p>
        {!success.sessionsRevoked && !success.signedOut && (
          <Button type="button" variant="danger" disabled={busy} onClick={signOutEverywhere}>
            Завершить все сеансы
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={success.signedOut ? '/auth/login' : '/profile'}>
            {success.signedOut ? 'Войти снова' : 'Вернуться в профиль'}
          </Link>
        </Button>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {mode === 'current' && (
        <div className="space-y-2">
          <Label htmlFor="current-password">Текущий пароль</Label>
          <PasswordInput
            id="current-password"
            ref={currentPasswordRef}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setFieldErrors((value) => ({ ...value, currentPassword: undefined }));
            }}
            invalid={Boolean(fieldErrors.currentPassword)}
            aria-describedby={fieldErrors.currentPassword ? 'current-password-error' : undefined}
            required
          />
          <FieldError id="current-password-error" message={fieldErrors.currentPassword} />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="new-password">Новый пароль</Label>
        <PasswordInput
          id="new-password"
          ref={passwordRef}
          minLength={PASSWORD_MIN_CHARACTERS}
          maxLength={PASSWORD_MAX_CHARACTERS}
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setFieldErrors((value) => ({ ...value, password: undefined }));
          }}
          invalid={Boolean(fieldErrors.password)}
          aria-describedby="new-password-requirements new-password-error"
          required
        />
        <p id="new-password-requirements" className="text-xs text-[var(--color-text-muted)]">
          Минимум 12 символов: заглавная и строчная латинские буквы, цифра.
        </p>
        <FieldError id="new-password-error" message={fieldErrors.password} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Повторите новый пароль</Label>
        <PasswordInput
          id="confirm-password"
          ref={confirmRef}
          minLength={PASSWORD_MIN_CHARACTERS}
          maxLength={PASSWORD_MAX_CHARACTERS}
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            setFieldErrors((value) => ({ ...value, confirm: undefined }));
          }}
          invalid={Boolean(fieldErrors.confirm)}
          aria-describedby={fieldErrors.confirm ? 'confirm-password-error' : undefined}
          required
        />
        <FieldError id="confirm-password-error" message={fieldErrors.confirm} />
      </div>
      {mode === 'current' && (
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
      )}
      <FieldError id="password-captcha-error" message={fieldErrors.captcha} />
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Сохраняем...' : 'Изменить пароль'}
      </Button>
    </form>
  );
}
