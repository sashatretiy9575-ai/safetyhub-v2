'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, UserCircleCheck } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AvatarUploader } from '@/components/profile/avatar-uploader';
import { EducationSelect } from '@/components/profile/education-select';
import { PhoneInput } from '@/components/profile/phone-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import { localizePathname, type AppLocale } from '@/i18n/config';
import {
  educationLevel,
  normalizeProfileSubmissionValues,
  PROFILE_FIELD_LIMITS,
  validateProfileSubmissionValues,
  type ProfileField,
  type ProfileSubmissionField,
  type ProfileSubmissionValues as OnboardingProfileValues,
  type ProfileValidationError,
} from '@/lib/profile/fields';
import type { PhoneCountryOption } from '@/lib/phone/countries';

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
  phoneRequired,
}: {
  initial: OnboardingProfileValues;
  initialAvatarUrl: string | null;
  countryOptions: readonly PhoneCountryOption[];
  phoneRequired: boolean;
}) {
  const router = useRouter();
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Profile');
  const tErrors = useTranslations('Common.errors');
  // An older free-text answer is kept only when it names a level.
  const [form, setForm] = useState(() => ({
    ...initial,
    education: educationLevel(initial.education) ?? '',
  }));
  const [avatarReady, setAvatarReady] = useState(Boolean(initialAvatarUrl));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const surnameRef = useRef<HTMLInputElement>(null);
  const jobRef = useRef<HTMLInputElement>(null);
  const organizationRef = useRef<HTMLInputElement>(null);
  const educationRef = useRef<HTMLSelectElement>(null);
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
          education: curr.education || educationLevel(draft.education) || '',
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

  const update = (field: ProfileField) => (event: React.ChangeEvent<HTMLInputElement>) => {
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
            : errors.education
              ? educationRef.current
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
    const errors: FieldErrors = validateProfileSubmissionValues(form, { phoneRequired });
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
        // The database refuses a name written in another script as a last
        // resort; say so in words instead of leaving the code on screen.
        if (payload?.error === 'PROFILE_NAME_SCRIPT') {
          setFieldErrors((current) => ({ ...current, name: { code: 'NAME_SCRIPT' } }));
          setMessage(t('validation.nameScript'));
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
    if (error.code === 'NAME_SCRIPT') return t('validation.nameScript');
    if (error.code === 'TOO_LONG') return t('validation.tooLong', { max: error.maxLength });
    if (error.code === 'PHONE_COUNTRY_REQUIRED') return t('validation.phoneCountry');
    return t('validation.phoneInvalid');
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="sr-only" htmlFor="onboarding-name">{t('name')}</Label>
          <Input
          placeholder={t('name')}
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
          <Label className="sr-only" htmlFor="onboarding-surname">{t('surname')}</Label>
          <Input
          placeholder={t('surname')}
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
          <Label className="sr-only" htmlFor="onboarding-job">{t('job')}</Label>
          <Input
          placeholder={t('job')}
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
          <Label className="sr-only" htmlFor="onboarding-organization">{t('organization')}</Label>
          <Input
          placeholder={t('organization')}
            ref={organizationRef}
            id="onboarding-organization"
            list="onboarding-organization-options"
            autoComplete="organization"
            maxLength={PROFILE_FIELD_LIMITS.organization}
            value={form.organization}
            onChange={update('organization')}
            invalid={Boolean(fieldErrors.organization)}
            aria-describedby={fieldErrors.organization ? 'onboarding-organization-error' : undefined}
            required
          />
          <datalist id="onboarding-organization-options">
            {organizations.map((organization) => (
              <option key={organization} value={organization} />
            ))}
          </datalist>
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
        <div className="space-y-2 sm:col-span-2">
          <Label className="sr-only" htmlFor="onboarding-education">{t('education')}</Label>
          <EducationSelect
            ref={educationRef}
            id="onboarding-education"
            value={form.education}
            onChange={(education) => {
              setForm((current) => ({ ...current, education }));
              setFieldErrors((current) => ({ ...current, education: undefined }));
            }}
            invalid={Boolean(fieldErrors.education)}
            aria-describedby={
              fieldErrors.education ? 'onboarding-education-error' : 'onboarding-education-help'
            }
          />
          <p id="onboarding-education-help" className="text-xs text-[var(--color-text-muted)]">
            {t('educationHint')}
          </p>
          {fieldErrors.education ? (
            <p
              id="onboarding-education-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {validationMessage(fieldErrors.education)}
            </p>
          ) : null}
        </div>
        <div ref={phoneContainerRef} className="space-y-2 sm:col-span-2">
          <Label className="sr-only" htmlFor="onboarding-phone">
            {t('phone')}
          </Label>
          <PhoneInput
            id="onboarding-phone"
            optional={!phoneRequired}
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
            <p
              id="onboarding-phone-error"
              role="alert"
              className="text-xs text-[var(--color-danger)]"
            >
              {validationMessage(fieldErrors.phone)}
            </p>
          ) : null}
        </div>
      </div>

      <section
        ref={avatarSectionRef}
        tabIndex={-1}
        aria-labelledby="onboarding-photo-title"
        className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 p-4 outline-none sm:p-6"
      >
        <div className="text-center">
          <h2 id="onboarding-photo-title" className="font-display text-lg font-bold">
            {t('avatar')}
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t('avatarHint')}</p>
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
