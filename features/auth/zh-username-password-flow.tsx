'use client';

import { SignIn, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

const LOGIN_FAILURE = '用户名或密码不正确，或账户暂时无法登录。';
const REGISTRATION_FAILURE = '无法创建账户。请检查填写内容后重试。';
const REGISTRATION_COMPLETE = '账号已创建。请用相同的用户名和密码继续登录。';
const AUTO_LOGIN_PENDING = '账号已创建，正在安全登录…';
const AUTO_LOGIN_FALLBACK = `${REGISTRATION_COMPLETE} 请点击“登录”后重试。`;
const CAPTCHA_RETRY = '验证码验证未完成，请重新提交。';
const UNAVAILABLE = '服务暂时不可用，请稍后重试。';

function safeLanding(value: unknown) {
  return value === '/admin' ||
    value === '/zh/auth/legal' ||
    value === '/zh/onboarding' ||
    value === '/zh/profile'
    ? value
    : '/zh/profile';
}

function validationErrors(mode: Mode, fields: Fields): FieldErrors {
  const parsed =
    mode === 'login'
      ? zhUsernamePasswordLoginSchema.safeParse(fields)
      : zhUsernamePasswordRegistrationSchema.safeParse(fields);
  if (parsed.success) return {};

  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'username') {
      errors.username = '请输入 3–32 个字符的拉丁用户名（小写字母开头）。';
    } else if (field === 'password') {
      errors.password = '密码至少 12 个字符，并同时包含大小写字母和数字。';
    } else if (field === 'passwordConfirmation') {
      errors.passwordConfirmation = '两次输入的密码不一致。';
    } else if (field === 'legalAccepted') {
      errors.legalAccepted = '请先同意使用条款和隐私政策。';
    }
  }
  return errors;
}

export function ZhUsernamePasswordFlow() {
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
        setMessage(AUTO_LOGIN_PENDING);
        return;
      }
      if (!result.ok || payload?.verified !== true) {
        const unavailable = payload?.error === 'ZH_AUTH_UNAVAILABLE';
        setMessageKind('error');
        setMessage(unavailable ? UNAVAILABLE : registering ? REGISTRATION_FAILURE : LOGIN_FAILURE);
        return;
      }
      router.replace(safeLanding(payload.redirectTo));
      router.refresh();
    } catch {
      setMessageKind('error');
      setMessage(UNAVAILABLE);
    } finally {
      if (!automaticLoginStarted) resetCaptcha();
      setBusy(false);
    }
  }, [fields, mode, resetCaptcha, router, setAutomaticLoginPending]);

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
    const nextErrors = validationErrors(mode, fields);
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
        <h1 className="font-display text-2xl font-bold">账号访问</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          中文用户使用拉丁用户名和密码访问账号。
        </p>
      </div>

      <div
        role="group"
        aria-label="账号操作"
        className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-1"
      >
        <button
          type="button"
          aria-pressed={!isRegistration}
          disabled={busy || autoLoginPending}
          onClick={() => chooseMode('login')}
          className={`min-h-10 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-semibold transition-colors ${!isRegistration ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
        >
          登录
        </button>
        <button
          type="button"
          aria-pressed={isRegistration}
          disabled={busy || autoLoginPending}
          onClick={() => chooseMode('register')}
          className={`min-h-10 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-semibold transition-colors ${isRegistration ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
        >
          创建访问账号
        </button>
      </div>

      <form className="space-y-4" noValidate onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor={`zh-${mode}-username`}>拉丁用户名</Label>
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
            3–32 个字符；以小写英文字母开头，可使用数字、点、下划线或连字符。
          </p>
          <FieldError id={`zh-${mode}-username-error`} message={errors.username} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`zh-${mode}-password`}>密码</Label>
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
              密码至少 12 个字符，最多 72 个 UTF-8 字节，并同时包含大小写字母和数字。
            </p>
          ) : null}
        </div>

        {isRegistration ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="zh-register-password-confirmation">确认密码</Label>
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
                  我已阅读并同意{' '}
                  <Link className="underline underline-offset-4" href="/zh/terms">
                    使用条款
                  </Link>{' '}
                  和{' '}
                  <Link className="underline underline-offset-4" href="/zh/privacy">
                    隐私政策
                  </Link>
                  。
                </span>
              </label>
              <FieldError id="zh-register-legal-error" message={errors.legalAccepted} />
            </div>
          </>
        ) : null}

        <Button className="min-h-11 w-full" type="submit" disabled={busy || autoLoginPending}>
          {busy || autoLoginPending ? '请稍候…' : isRegistration ? '创建并继续' : '登录'}
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
          创建后由管理员审核。登录和审核不需要电子邮箱或电话号码。
        </p>
      ) : (
        <p className="text-sm leading-6 text-[var(--color-text-muted)]">
          无法登录或忘记密码时，请联系管理员。管理员核验后可协助重设；没有自助找回渠道。
        </p>
      )}
    </>
  );
}
