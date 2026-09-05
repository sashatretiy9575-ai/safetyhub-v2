'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, UserCircleCheck } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AvatarUploader } from '@/features/profile/avatar-uploader';
import { PhoneInput } from '@/features/profile/phone-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import { localizePathname, type AppLocale } from '@/i18n/config';
import {
  normalizeProfileSubmissionValues,
  PROFILE_FIELD_LIMITS,
  validateProfileSubmissionValues,
  type ProfileField,
  type ProfileSubmissionField,
  type ProfileSubmissionValues as OnboardingProfileValues,
  type ProfileValidationError,
} from '@/features/profile/fields';
import type { PhoneCountryOption } from '@/lib/phone';

type FieldError = ProfileValidationError | Readonly<{ code: 'AVATAR_REQUIRED' }>;
type FieldErrors = Partial<Record<ProfileSubmissionField | 'avatar', FieldError>>;

type OrganizationResponse = {
  organizations?: string[];
};

type ErrorResponse = {
  error?: string;
};

export function OnboardingForm({
  initial,
  initialAvatarUrl,
  countryOptions,
}: {
  initial: OnboardingProfileValues;
  initialAvatarUrl: string | null;
  countryOptions: readonly PhoneCountryOption[];
}) {
  const router = useRouter();
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Profile');
  const tErrors = useTranslations('Common.errors');
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
  const phoneContainerRef = useRef<HTMLDivElement>(null);
  const avatarSectionRef = useRef<HTMLElement>(null);

  const ONBOARDING_DRAFT_KEY = 'safetyhub:onboarding:draft';

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ONBOARDING_DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        setForm((curr) => ({
          name: curr.name || draft.name || '',
          surname: curr.surname || draft.surname || '',
          job: curr.job || draft.job || '',
          organization: curr.organization || draft.organization || '',
          phone: curr.phone || draft.phone || '',
        }));
      }
    } catch {
      // Storage unavailable or invalid JSON
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(form));
    } catch {
      // Storage quota or unavailable
    }
  }, [form]);

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
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [form.organization]);

  const update =
    (field: ProfileField) => (event: React.ChangeEvent<HTMLInputElement>) => {
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
            : errors.phone
              ? phoneContainerRef.current?.querySelector('input')
              : errors.avatar
                ? avatarSectionRef.current
                : null;
    requestAnimationFrame(() => {
      if (target) {
        target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        target.focus?.();
      }
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const errors: FieldErrors = validateProfileSubmissionValues(form);
    if (!avatarReady) errors.avatar = { code: 'AVATAR_REQUIRED' };
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setMessage(t('required'));
      focusFirstInvalid(errors);
      return;
    }

    setBusy(true);
    setMessage(t('submitting'));
    try {
      const result = await clientRequest('/api/profile/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizeProfileSubmissionValues(form)),
      });
      if (!result.ok) {
        const payload = await readClientResponseJson<ErrorResponse>(result.response);
        if (payload?.error === 'AVATAR_REQUIRED') {
          setAvatarReady(false);
          setFieldErrors((current) => ({
            ...current,
            avatar: { code: 'AVATAR_REQUIRED' },
          }));
          setMessage(t('avatarMissing'));
          return;
        }
        setMessage(localizedClientRequestMessage(result.error, t('saveFailed'), tErrors));
        return;
      }
      try {
        localStorage.removeItem(ONBOARDING_DRAFT_KEY);
      } catch {
        // Ignore storage errors
      }
      router.replace(localizePathname('/profile', locale));
      router.refresh();
    } catch (error) {
      setMessage(localizedClientRequestMessage(error, t('saveFailed'), tErrors));
    } finally {
      setBusy(false);
    }
  };

  const initials = `${form.name.slice(0, 1)}${form.surname.slice(0, 1)}`.toUpperCase() || 'SH';

  const validationMessage = (error: FieldError | undefined) => {
    if (!error) return '';
    if (error.code === 'AVATAR_REQUIRED') return t('avatarRequired');
    if (error.code === 'REQUIRED') return t('validation.required');
    if (error.code === 'CONTROL_CHARACTERS') return t('validation.controlCharacters');
    if (error.code === 'TOO_LONG') return t('validation.tooLong', { max: error.maxLength });
    if (error.code === 'PHONE_COUNTRY_REQUIRED') return t('validation.phoneCountry');
    return t('validation.phoneInvalid');
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="onboarding-name">{t('name')}</Label>
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
              {validationMessage(fieldErrors.name)}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="onboarding-surname">{t('surname')}</Label>
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
              {validationMessage(fieldErrors.surname)}
            </p>
          ) : null}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="onboarding-job">{t('job')}</Label>
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
              {validationMessage(fieldErrors.job)}
            </p>
          ) : null}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="onboarding-organization">{t('organization')}</Label>
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
            {t('organizationHint')}
          </p>
          {fieldErrors.organization ? (
            <p
              id="onboarding-organization-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {validationMessage(fieldErrors.organization)}
            </p>
          ) : null}
        </div>
        <div ref={phoneContainerRef} className="space-y-2 sm:col-span-2">
          <Label htmlFor="onboarding-phone">{t('phone')}</Label>
          <PhoneInput
            id="onboarding-phone"
            countryOptions={countryOptions}
            value={form.phone}
            onChange={(phone) => {
              setForm((current) => ({ ...current, phone }));
              setFieldErrors((current) => ({ ...current, phone: undefined }));
            }}
            invalid={Boolean(fieldErrors.phone)}
            describedBy={fieldErrors.phone ? 'onboarding-phone-error' : 'onboarding-phone-help'}
            disabled={busy}
          />
          <p id="onboarding-phone-help" className="text-xs text-[var(--color-text-muted)]">
            {t('phoneHint')}
          </p>
          {fieldErrors.phone ? (
            <p id="onboarding-phone-error" role="alert" className="text-xs text-[var(--color-danger)]">
              {validationMessage(fieldErrors.phone)}
            </p>
          ) : null}
        </div>
      </div>

      <section
        ref={avatarSectionRef}
        tabIndex={-1}
        aria-labelledby="onboarding-photo-title"
        className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 p-4 sm:p-6 outline-none"
      >
        <div className="text-center">
          <h2 id="onboarding-photo-title" className="font-display text-lg font-bold">
            {t('avatar')}
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {t('avatarHint')}
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
            {validationMessage(fieldErrors.avatar)}
          </p>
        ) : null}
      </section>

      <div className="space-y-3">
        <Button type="submit" size="xl" className="w-full" disabled={busy}>
          <UserCircleCheck size={19} />
          {busy ? t('submitting') : t('submit')}
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
