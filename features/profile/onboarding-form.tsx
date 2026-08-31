'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, UserCircleCheck } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { AvatarUploader } from '@/features/profile/avatar-uploader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import {
  normalizeProfileValues,
  PROFILE_FIELD_LIMITS,
  validateProfileValues,
  type ProfileValues as OnboardingProfileValues,
} from '@/features/profile/fields';

type FieldErrors = Partial<Record<keyof OnboardingProfileValues | 'avatar', string>>;

type OrganizationResponse = {
  organizations?: string[];
};

type ErrorResponse = {
  error?: string;
};

export function OnboardingForm({
  initial,
  initialAvatarUrl,
}: {
  initial: OnboardingProfileValues;
  initialAvatarUrl: string | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [avatarReady, setAvatarReady] = useState(Boolean(initialAvatarUrl));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const surnameRef = useRef<HTMLInputElement>(null);
  const jobRef = useRef<HTMLInputElement>(null);
  const organizationRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = form.organization.trim();
    if (query.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await clientRequest(
          `/api/profile/organizations?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (!result.ok) return;
        const payload = await readClientResponseJson<OrganizationResponse>(result.response);
        if (!controller.signal.aborted && Array.isArray(payload?.organizations)) {
          setOrganizations(payload.organizations.filter((item) => typeof item === 'string'));
        }
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [form.organization]);

  const update =
    (field: keyof OnboardingProfileValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
      setFieldErrors((current) => ({ ...current, [field]: undefined }));
    };

  const focusFirstInvalid = (errors: FieldErrors) => {
    const target = errors.name
      ? nameRef.current
      : errors.surname
        ? surnameRef.current
        : errors.job
          ? jobRef.current
          : errors.organization
            ? organizationRef.current
            : null;
    requestAnimationFrame(() => target?.focus());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const errors: FieldErrors = validateProfileValues(form);
    if (!avatarReady) errors.avatar = 'Добавьте фотографию перед продолжением.';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setMessage('Заполните обязательные поля.');
      focusFirstInvalid(errors);
      return;
    }

    setBusy(true);
    setMessage('Сохраняем профиль…');
    try {
      const result = await clientRequest('/api/profile/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizeProfileValues(form)),
      });
      if (!result.ok) {
        const payload = await readClientResponseJson<ErrorResponse>(result.response);
        if (payload?.error === 'AVATAR_REQUIRED') {
          setAvatarReady(false);
          setFieldErrors((current) => ({ ...current, avatar: 'Добавьте фотографию.' }));
          setMessage('Фотография не найдена. Загрузите её ещё раз.');
          return;
        }
        setMessage(clientRequestMessage(result.error, 'Не удалось завершить заполнение профиля.'));
        return;
      }
      router.replace('/topics');
      router.refresh();
    } catch (error) {
      setMessage(clientRequestMessage(error, 'Не удалось завершить заполнение профиля.'));
    } finally {
      setBusy(false);
    }
  };

  const initials = `${form.name.slice(0, 1)}${form.surname.slice(0, 1)}`.toUpperCase() || 'SH';

  return (
    <form onSubmit={submit} className="space-y-7" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="onboarding-name">Имя</Label>
          <Input
            ref={nameRef}
            id="onboarding-name"
            autoComplete="given-name"
            maxLength={PROFILE_FIELD_LIMITS.name}
            value={form.name}
            onChange={update('name')}
            invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? 'onboarding-name-error' : undefined}
            required
          />
          {fieldErrors.name ? (
            <p
              id="onboarding-name-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {fieldErrors.name}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="onboarding-surname">Фамилия</Label>
          <Input
            ref={surnameRef}
            id="onboarding-surname"
            autoComplete="family-name"
            maxLength={PROFILE_FIELD_LIMITS.surname}
            value={form.surname}
            onChange={update('surname')}
            invalid={Boolean(fieldErrors.surname)}
            aria-describedby={fieldErrors.surname ? 'onboarding-surname-error' : undefined}
            required
          />
          {fieldErrors.surname ? (
            <p
              id="onboarding-surname-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {fieldErrors.surname}
            </p>
          ) : null}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="onboarding-job">Должность</Label>
          <Input
            ref={jobRef}
            id="onboarding-job"
            autoComplete="organization-title"
            maxLength={PROFILE_FIELD_LIMITS.job}
            value={form.job}
            onChange={update('job')}
            invalid={Boolean(fieldErrors.job)}
            aria-describedby={fieldErrors.job ? 'onboarding-job-error' : undefined}
            required
          />
          {fieldErrors.job ? (
            <p
              id="onboarding-job-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {fieldErrors.job}
            </p>
          ) : null}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="onboarding-organization">Название компании</Label>
          <Input
            ref={organizationRef}
            id="onboarding-organization"
            list="onboarding-organization-options"
            autoComplete="organization"
            maxLength={PROFILE_FIELD_LIMITS.organization}
            value={form.organization}
            onChange={update('organization')}
            invalid={Boolean(fieldErrors.organization)}
            aria-describedby={
              fieldErrors.organization
                ? 'onboarding-organization-help onboarding-organization-error'
                : 'onboarding-organization-help'
            }
            required
          />
          <datalist id="onboarding-organization-options">
            {organizations.map((organization) => (
              <option key={organization} value={organization} />
            ))}
          </datalist>
          <p id="onboarding-organization-help" className="text-xs text-[var(--color-text-muted)]">
            Выберите найденный вариант или введите название самостоятельно.
          </p>
          {fieldErrors.organization ? (
            <p
              id="onboarding-organization-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {fieldErrors.organization}
            </p>
          ) : null}
        </div>
      </div>

      <section
        aria-labelledby="onboarding-photo-title"
        className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 p-4 sm:p-6"
      >
        <div className="text-center">
          <h2 id="onboarding-photo-title" className="font-display text-lg font-bold">
            Фотография профиля
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Сделайте снимок камерой или выберите готовую фотографию.
          </p>
        </div>
        <AvatarUploader
          initialUrl={initialAvatarUrl}
          initials={initials}
          required
          onUploaded={() => {
            setAvatarReady(true);
            setFieldErrors((current) => ({ ...current, avatar: undefined }));
          }}
        />
        {fieldErrors.avatar ? (
          <p role="alert" className="text-center text-xs text-[var(--color-danger)]">
            {fieldErrors.avatar}
          </p>
        ) : null}
      </section>

      <div className="space-y-3">
        <Button type="submit" className="w-full" disabled={busy}>
          <UserCircleCheck size={19} />
          {busy ? 'Сохраняем…' : 'Сохранить и перейти к курсам'}
          {!busy ? <ArrowRight size={18} /> : null}
        </Button>
        {message ? (
          <p
            role="status"
            aria-live="polite"
            className="text-center text-sm text-[var(--color-text-muted)]"
          >
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
