'use client';

import { SignIn, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
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
const REGISTRATION_COMPLETE = '账号已创建，请使用用户名和密码登录。';
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

export function ZhUsernamePasswordFlow({
  mode,
  registrationComplete = false,
}: {
  mode: Mode;
  registrationComplete?: boolean;
}) {
  const router = useRouter();
  const isRegistration = mode === 'register';
  const [fields, setFields] = useState<Fields>({
    username: '',
    password: '',
    passwordConfirmation: '',
    legalAccepted: false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState(
    !isRegistration && registrationComplete ? REGISTRATION_COMPLETE : '',
  );
  const [busy, setBusy] = useState(false);
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const pendingCaptchaSubmitRef = useRef<((token: string) => void) | null>(null);
  const captchaRequired = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  const setField = <Field extends keyof Fields>(field: Field, value: Fields[Field]) => {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setMessage('');
  };

  const resetCaptcha = () => {
    pendingCaptchaSubmitRef.current = null;
    setCaptchaVersion((value) => value + 1);
  };

  const submitRequest = async (captchaToken?: string) => {
    setBusy(true);
    setMessage('');
    try {
      const body = isRegistration
        ? {
            username: fields.username,
            password: fields.password,
            passwordConfirmation: fields.passwordConfirmation,
            legalAccepted: fields.legalAccepted,
            captchaToken,
          }
        : { username: fields.username, password: fields.password, captchaToken };
      const result = await clientRequest(
        isRegistration ? '/api/auth/zh/register' : '/api/auth/zh/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = await readClientResponseJson<AuthResponse>(result.response);
      if (isRegistration && result.ok && payload?.registered === true) {
        router.replace('/zh/auth/login?registered=1');
        router.refresh();
        return;
      }
      if (!result.ok || payload?.verified !== true) {
        const unavailable = payload?.error === 'ZH_AUTH_UNAVAILABLE';
        setMessage(
          unavailable ? UNAVAILABLE : isRegistration ? REGISTRATION_FAILURE : LOGIN_FAILURE,
        );
        return;
      }
      router.replace(safeLanding(payload.redirectTo));
      router.refresh();
    } catch {
      setMessage(UNAVAILABLE);
    } finally {
      resetCaptcha();
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || pendingCaptchaSubmitRef.current) return;
    const nextErrors = validationErrors(mode, fields);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    if (captchaRequired) {
      pendingCaptchaSubmitRef.current = (token) => void submitRequest(token);
      setMessage('');
      turnstileRef.current?.execute();
      return;
    }
    void submitRequest();
  };

  const Icon = isRegistration ? UserPlus : SignIn;
  const title = isRegistration ? '创建账号' : '登录';

  return (
    <>
      <div className="space-y-2 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <Icon size={24} />
        </span>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          中文用户使用拉丁用户名和密码访问账号。
        </p>
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

            <div className="space-y-2">
              <label
                className="flex items-start gap-3 text-sm text-[var(--color-text-muted)]"
                htmlFor="zh-register-legal"
              >
                <input
                  id="zh-register-legal"
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-[var(--color-border-strong)]"
                  checked={fields.legalAccepted}
                  onChange={(event) => setField('legalAccepted', event.target.checked)}
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

        <Button className="min-h-11 w-full" type="submit" disabled={busy}>
          {busy ? '请稍候…' : isRegistration ? '创建账号并继续' : '登录'}
        </Button>
      </form>

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
          setMessage(CAPTCHA_RETRY);
          setCaptchaVersion((value) => value + 1);
        }}
      />

      {message ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {message}
        </p>
      ) : null}

      {isRegistration ? (
        <p className="text-sm leading-6 text-[var(--color-text-muted)]">
          创建后，账号会直接进入管理员审核。登录和审核不需要电子邮箱或电话号码。
        </p>
      ) : (
        <p className="text-sm leading-6 text-[var(--color-text-muted)]">
          无法登录或忘记密码时，请联系管理员。管理员核验后可协助重设；没有自助找回渠道。
        </p>
      )}

      <p className="text-center text-sm text-[var(--color-text-muted)]">
        {isRegistration ? '已有账号？' : '还没有账号？'}{' '}
        <Link
          className="font-medium text-[var(--color-primary)] hover:underline"
          href={isRegistration ? '/zh/auth/login' : '/zh/auth/register'}
        >
          {isRegistration ? '登录' : '创建账号'}
        </Link>
      </p>
    </>
  );
}
