'use client';

import { useRef, useState } from 'react';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError } from '@/features/auth/form-controls';
import { compressAvatar } from '@/lib/avatar-image';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';

type Mode = 'login' | 'register';
type BusyAction = 'login' | 'register' | 'recovery' | null;

type ApiPayload = {
  error?: unknown;
  requestId?: unknown;
  operationId?: unknown;
  publicKey?: unknown;
  verified?: unknown;
  redirectTo?: unknown;
  recoveryCode?: unknown;
};

const errorMessages: Record<string, string> = {
  RATE_LIMITED: '操作过于频繁，请稍后重试。',
  ZH_AUTHENTICATION_FAILED: '无法验证通行密钥，请重试。',
  ZH_REGISTRATION_FAILED: '无法完成注册，请检查资料后重试。',
  ZH_RECOVERY_FAILED: '恢复码无效、已使用或已过期。',
  ZH_AUTH_UNAVAILABLE: '登录服务暂时不可用，请稍后重试。',
};

function safeRedirect(value: unknown) {
  return value === '/zh/profile' ? value : '/zh/profile';
}

function bytesToBase64url(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function jsonRequest(path: string, body: unknown) {
  const result = await clientRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readClientResponseJson<ApiPayload>(result.response);
  if (!result.ok || !payload) {
    const code = typeof payload?.error === 'string' ? payload.error : '';
    throw new Error(errorMessages[code] ?? '请求失败，请稍后重试。');
  }
  return payload;
}

function webAuthnAvailable() {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window;
}

export function ZhPasskeyFlow({ mode }: { mode: Mode }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);

  const login = async () => {
    if (busy) return;
    setBusy('login');
    setError('');
    try {
      if (!webAuthnAvailable()) throw new Error('此设备或浏览器不支持通行密钥。');
      const options = await jsonRequest('/api/auth/zh/authentication/options', {});
      if (typeof options.requestId !== 'string' || !options.publicKey) {
        throw new Error('登录服务暂时不可用，请稍后重试。');
      }
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const assertion = await startAuthentication({
        optionsJSON: options.publicKey as PublicKeyCredentialRequestOptionsJSON,
      });
      const verified = await jsonRequest('/api/auth/zh/authentication/verify', {
        requestId: options.requestId,
        response: assertion,
      });
      if (verified.verified !== true) throw new Error('无法验证通行密钥，请重试。');
      router.replace(safeRedirect(verified.redirectTo));
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法验证通行密钥，请重试。');
    } finally {
      setBusy(null);
    }
  };

  const recover = async () => {
    if (busy) return;
    setBusy('recovery');
    setError('');
    try {
      if (!webAuthnAvailable()) throw new Error('此设备或浏览器不支持通行密钥。');
      const options = await jsonRequest('/api/auth/zh/recovery/verify', {
        action: 'options',
        recoveryCode: recoveryInput.trim(),
      });
      if (typeof options.requestId !== 'string' || !options.publicKey) {
        throw new Error('恢复码无效、已使用或已过期。');
      }
      const { startRegistration } = await import('@simplewebauthn/browser');
      const credential = await startRegistration({
        optionsJSON: options.publicKey as PublicKeyCredentialCreationOptionsJSON,
      });
      const verified = await jsonRequest('/api/auth/zh/recovery/verify', {
        action: 'verify',
        requestId: options.requestId,
        recoveryCode: recoveryInput.trim(),
        response: credential,
      });
      if (verified.verified !== true || typeof verified.recoveryCode !== 'string') {
        throw new Error('无法恢复通行密钥，请重试。');
      }
      setRecoveryInput('');
      setRecoveryCode(verified.recoveryCode);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法恢复通行密钥，请重试。');
    } finally {
      setBusy(null);
    }
  };

  const register = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy('register');
    setError('');
    try {
      if (!webAuthnAvailable()) throw new Error('此设备或浏览器不支持通行密钥。');
      const form = new FormData(event.currentTarget);
      const photo = fileRef.current?.files?.[0];
      if (!photo) throw new Error('请选择个人照片。');
      const compressed = await compressAvatar(photo);
      const avatarBytes = new Uint8Array(await compressed.arrayBuffer());
      const profile = {
        name: String(form.get('name') ?? ''),
        surname: String(form.get('surname') ?? ''),
        job: String(form.get('job') ?? ''),
        organization: String(form.get('organization') ?? ''),
        phone: {
          countryIso2: String(form.get('phoneCountryIso2') ?? ''),
          nationalNumber: String(form.get('phone') ?? ''),
        },
        legalAccepted: form.get('legalAccepted') === 'on',
        avatar: {
          sha256: await sha256Hex(avatarBytes),
          bytes: avatarBytes.byteLength,
        },
      };
      const options = await jsonRequest('/api/auth/zh/registration/options', profile);
      if (typeof options.operationId !== 'string' || !options.publicKey) {
        throw new Error('注册服务暂时不可用，请稍后重试。');
      }
      const { startRegistration } = await import('@simplewebauthn/browser');
      const credential = await startRegistration({
        optionsJSON: options.publicKey as PublicKeyCredentialCreationOptionsJSON,
      });
      const verified = await jsonRequest('/api/auth/zh/registration/verify', {
        ...profile,
        operationId: options.operationId,
        avatarPayload: {
          mimeType: compressed.type,
          base64url: bytesToBase64url(avatarBytes),
        },
        response: credential,
      });
      if (verified.verified !== true || typeof verified.recoveryCode !== 'string') {
        throw new Error('无法完成注册，请重试。');
      }
      setRecoveryCode(verified.recoveryCode);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法完成注册，请重试。');
    } finally {
      setBusy(null);
    }
  };

  if (recoveryCode) {
    return (
      <div className="space-y-5" aria-live="polite">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">请保存恢复码</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            此恢复码只显示一次。请离线保存，切勿发送给他人。
          </p>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 font-mono text-sm break-all select-all">
          {recoveryCode}
        </div>
        <Button
          type="button"
          className="min-h-11 w-full"
          onClick={() => void navigator.clipboard?.writeText(recoveryCode)}
        >
          复制恢复码
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          onClick={() => {
            router.replace('/zh/profile');
            router.refresh();
          }}
        >
          我已安全保存，继续
        </Button>
      </div>
    );
  }

  if (mode === 'login') {
    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold">使用通行密钥登录</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            使用设备的指纹、面容或 PIN，无需邮箱、短信或密码。
          </p>
        </div>
        {error ? <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p> : null}
        <Button
          type="button"
          className="min-h-11 w-full"
          disabled={Boolean(busy)}
          onClick={() => void login()}
        >
          {busy === 'login' ? '正在验证…' : '使用通行密钥登录'}
        </Button>
        <button
          type="button"
          className="min-h-11 w-full text-sm underline underline-offset-4"
          onClick={() => setShowRecovery((value) => !value)}
        >
          无法使用原设备？使用恢复码
        </button>
        {showRecovery ? (
          <div className="space-y-3">
            <Label htmlFor="zh-recovery-code">恢复码</Label>
            <Input
              id="zh-recovery-code"
              value={recoveryInput}
              onChange={(event) => setRecoveryInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="min-h-11"
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
              disabled={Boolean(busy) || !recoveryInput.trim()}
              onClick={() => void recover()}
            >
              {busy === 'recovery' ? '正在恢复…' : '创建新的通行密钥'}
            </Button>
          </div>
        ) : null}
        <p className="text-center text-sm text-[var(--color-text-muted)]">
          还没有账户？{' '}
          <Link href="/zh/auth/register" className="underline underline-offset-4">
            注册
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={register} noValidate>
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold">创建 SafetyHub 账户</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          填写资料后，在此设备上创建通行密钥。
        </p>
      </div>
      {(['surname', 'name', 'job', 'organization'] as const).map((field) => {
        const labels = {
          surname: '姓',
          name: '名',
          job: '职位',
          organization: '组织',
        };
        const maximums = { surname: 80, name: 80, job: 160, organization: 160 };
        return (
          <div className="space-y-2" key={field}>
            <Label htmlFor={`zh-${field}`}>{labels[field]}</Label>
            <Input
              id={`zh-${field}`}
              name={field}
              required
              maxLength={maximums[field]}
              autoComplete={field === 'name'
                ? 'given-name'
                : field === 'surname'
                  ? 'family-name'
                  : field === 'job'
                    ? 'organization-title'
                    : 'organization'}
              className="min-h-11"
            />
          </div>
        );
      })}
      <div className="grid grid-cols-[5.5rem_1fr] gap-3">
        <div className="space-y-2">
          <Label htmlFor="zh-phone-country">国家</Label>
          <Input
            id="zh-phone-country"
            name="phoneCountryIso2"
            defaultValue="KZ"
            maxLength={2}
            className="min-h-11 uppercase"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="zh-phone">联系电话</Label>
          <Input
            id="zh-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            maxLength={64}
            className="min-h-11"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="zh-avatar">个人照片</Label>
        <Input
          ref={fileRef}
          id="zh-avatar"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
          className="min-h-11"
        />
        <FieldError id="zh-avatar-error" message={undefined} />
      </div>
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input name="legalAccepted" type="checkbox" required className="mt-1 size-5" />
        <span>
          我已阅读并同意{' '}
          <Link href="/zh/terms" className="underline underline-offset-4">使用条款</Link>
          {' '}和{' '}
          <Link href="/zh/privacy" className="underline underline-offset-4">隐私政策</Link>。
        </span>
      </label>
      {error ? <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p> : null}
      <Button type="submit" className="min-h-11 w-full" disabled={Boolean(busy)}>
        {busy === 'register' ? '正在创建…' : '创建通行密钥并注册'}
      </Button>
      <p className="text-center text-sm text-[var(--color-text-muted)]">
        已有账户？{' '}
        <Link href="/zh/auth/login" className="underline underline-offset-4">登录</Link>
      </p>
    </form>
  );
}
