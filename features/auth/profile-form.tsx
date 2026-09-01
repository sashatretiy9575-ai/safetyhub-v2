'use client';

import { useEffect, useState } from 'react';
import { PencilSimple, X } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import {
  normalizeProfileSubmissionValues,
  PROFILE_FIELD_LIMITS,
  validateProfileSubmissionValues,
  type ProfileField,
  type ProfileSubmissionField,
  type ProfileSubmissionValues,
  type ProfileValidationError,
} from '@/features/profile/fields';
import { PhoneInput } from '@/features/profile/phone-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PhoneCountryOption } from '@/lib/phone';

type OrganizationResponse = { organizations?: string[] };
type UpdateResponse = {
  approvalState?: unknown;
};

export function ProfileForm({
  initial,
  countryOptions,
}: {
  initial: ProfileSubmissionValues;
  countryOptions: readonly PhoneCountryOption[];
}) {
  const router = useRouter();
  const t = useTranslations('Profile');
  const tErrors = useTranslations('Common.errors');
  const [form, setForm] = useState(initial);
  const [savedProfile, setSavedProfile] = useState(initial);
  const [errors, setErrors] = useState<
    Partial<Record<ProfileSubmissionField, ProfileValidationError>>
  >({});
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing || form.organization.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await clientRequest(
          `/api/profile/organizations?q=${encodeURIComponent(form.organization.trim())}`,
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
  }, [editing, form.organization]);

  const update = (field: ProfileField) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validation = validateProfileSubmissionValues(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      setMessage(t('required'));
      return;
    }

    const normalized = normalizeProfileSubmissionValues(form);
    setBusy(true);
    setMessage('');
    try {
      const result = await clientRequest('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalized),
      });
      const payload = await readClientResponseJson<UpdateResponse>(result.response);
      if (!result.ok) {
        setMessage(localizedClientRequestMessage(result.error, t('saveFailed'), tErrors));
        return;
      }
      setForm(normalized);
      setSavedProfile(normalized);
      setEditing(false);
      setMessage(
        payload?.approvalState === 'pending'
          ? t('savedForReview')
          : t('saved'),
      );
      router.refresh();
    } catch (requestError) {
      setMessage(localizedClientRequestMessage(requestError, t('saveFailed'), tErrors));
    } finally {
      setBusy(false);
    }
  };

  const cancelEditing = () => {
    setForm(savedProfile);
    setErrors({});
    setEditing(false);
    setMessage('');
  };

  const validationMessage = (error: ProfileValidationError | undefined) => {
    if (!error) return '';
    if (error.code === 'REQUIRED') return t('validation.required');
    if (error.code === 'CONTROL_CHARACTERS') return t('validation.controlCharacters');
    if (error.code === 'TOO_LONG') return t('validation.tooLong', { max: error.maxLength });
    if (error.code === 'PHONE_COUNTRY_REQUIRED') return t('validation.phoneCountry');
    return t('validation.phoneInvalid');
  };

  return (
    <div className="space-y-3">
      {!editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            <PencilSimple size={17} /> {t('edit')}
          </Button>
          {message ? (
            <p role="status" className="text-sm text-[var(--color-text-muted)]">
              {message}
            </p>
          ) : null}
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
          <div className="space-y-1">
            <Label htmlFor="profile-name">{t('name')}</Label>
            <Input
              id="profile-name"
              autoComplete="given-name"
              maxLength={PROFILE_FIELD_LIMITS.name}
              value={form.name}
              onChange={update('name')}
              invalid={Boolean(errors.name)}
              required
            />
            {errors.name ? (
              <p className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.name)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="profile-surname">{t('surname')}</Label>
            <Input
              id="profile-surname"
              autoComplete="family-name"
              maxLength={PROFILE_FIELD_LIMITS.surname}
              value={form.surname}
              onChange={update('surname')}
              invalid={Boolean(errors.surname)}
              required
            />
            {errors.surname ? (
              <p className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.surname)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="profile-job">{t('job')}</Label>
            <Input
              id="profile-job"
              autoComplete="organization-title"
              maxLength={PROFILE_FIELD_LIMITS.job}
              value={form.job}
              onChange={update('job')}
              invalid={Boolean(errors.job)}
              required
            />
            {errors.job ? (
              <p className="text-xs text-[var(--color-danger)]">{validationMessage(errors.job)}</p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="profile-organization">{t('organizationShort')}</Label>
            <Input
              id="profile-organization"
              list="profile-organizations"
              autoComplete="organization"
              maxLength={PROFILE_FIELD_LIMITS.organization}
              value={form.organization}
              onChange={update('organization')}
              invalid={Boolean(errors.organization)}
              required
            />
            <datalist id="profile-organizations">
              {organizations.map((organization) => (
                <option key={organization} value={organization} />
              ))}
            </datalist>
            {errors.organization ? (
              <p className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.organization)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="profile-phone">{t('phone')}</Label>
            <PhoneInput
              id="profile-phone"
              countryOptions={countryOptions}
              value={form.phone}
              onChange={(phone) => {
                setForm((current) => ({ ...current, phone }));
                setErrors((current) => ({ ...current, phone: undefined }));
              }}
              invalid={Boolean(errors.phone)}
              describedBy={errors.phone ? 'profile-phone-error' : 'profile-phone-help'}
              disabled={busy}
            />
            <p id="profile-phone-help" className="text-xs text-[var(--color-text-muted)]">
              {t('phoneHint')}
            </p>
            {errors.phone ? (
              <p id="profile-phone-error" className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.phone)}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? t('submitting') : t('save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancelEditing}>
              <X size={16} /> {t('cancel')}
            </Button>
          </div>
          {message ? (
            <p role="status" className="text-sm text-[var(--color-text-muted)] sm:col-span-2">
              {message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
