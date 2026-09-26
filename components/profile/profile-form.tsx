'use client';

import { useEffect, useState } from 'react';
import { PencilSimple, X } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import {
  educationLevel,
  normalizeProfileSubmissionValues,
  PROFILE_FIELD_LIMITS,
  validateProfileSubmissionValues,
  type ProfileField,
  type ProfileSubmissionField,
  type ProfileSubmissionValues,
  type ProfileValidationError,
} from '@/lib/profile/fields';
import { EducationSelect } from '@/components/profile/education-select';
import { PhoneInput } from '@/components/profile/phone-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PhoneCountryOption } from '@/lib/phone/countries';

type OrganizationResponse = { organizations?: string[] };

/** The fields in the order they sit on screen; each input's id is `profile-<field>`. */
const PROFILE_FIELD_ORDER = [
  'name',
  'surname',
  'job',
  'organization',
  'education',
  'phone',
] as const satisfies readonly ProfileSubmissionField[];
type UpdateResponse = {
  approvalState?: unknown;
  error?: string;
};

export function ProfileForm({
  initial,
  countryOptions,
  phoneRequired,
}: {
  initial: ProfileSubmissionValues;
  countryOptions: readonly PhoneCountryOption[];
  phoneRequired: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('Profile');
  const tErrors = useTranslations('Common.errors');
  // An older free-text answer is kept only when it names a level; a school's
  // name leaves the picker empty, and the next save asks for a level.
  const [savedProfile, setSavedProfile] = useState(() => ({
    ...initial,
    education: educationLevel(initial.education) ?? '',
  }));
  const [form, setForm] = useState(savedProfile);
  const [errors, setErrors] = useState<
    Partial<Record<ProfileSubmissionField, ProfileValidationError>>
  >({});
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The directory answers from three characters (search_profile_organizations).
    if (!editing || form.organization.trim().length < 3) return;
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
    const validation = validateProfileSubmissionValues(form, { phoneRequired });
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      setMessage(t('required'));
      // The first field to fix takes focus, so its message — linked through
      // aria-describedby — is read with it, as the onboarding form does.
      const first = PROFILE_FIELD_ORDER.find((field) => validation[field]);
      if (first) requestAnimationFrame(() => document.getElementById(`profile-${first}`)?.focus());
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
        // The database refuses a name written in another script as a last
        // resort; say so in words instead of leaving the code on screen.
        if (payload?.error === 'PROFILE_NAME_SCRIPT') {
          setErrors((current) => ({ ...current, name: { code: 'NAME_SCRIPT' } }));
          setMessage(t('validation.nameScript'));
          return;
        }
        setMessage(localizedClientRequestMessage(result.error, t('saveFailed'), tErrors));
        return;
      }
      setForm(normalized);
      setSavedProfile(normalized);
      setEditing(false);
      setMessage(payload?.approvalState === 'pending' ? t('savedForReview') : t('saved'));
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
    if (error.code === 'NAME_SCRIPT') return t('validation.nameScript');
    if (error.code === 'TOO_LONG') return t('validation.tooLong', { max: error.maxLength });
    if (error.code === 'PHONE_COUNTRY_REQUIRED') return t('validation.phoneCountry');
    return t('validation.phoneInvalid');
  };

  return (
    <div className="space-y-3">
      {/* One live region that outlives the switch between reading and editing:
          a status paragraph mounted together with its text is often not
          announced, and saving unmounts the form that held it. The visible
          copies below are for the eye only. */}
      <p role="status" className="sr-only">
        {message}
      </p>
      {!editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            <PencilSimple size={17} /> {t('edit')}
          </Button>
          {message ? (
            <p aria-hidden="true" className="text-sm text-[var(--color-text-muted)]">
              {message}
            </p>
          ) : null}
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
          <div className="space-y-1">
            <Label className="sr-only" htmlFor="profile-name">{t('name')}</Label>
            <Input
          placeholder={t('name')}
              id="profile-name"
              autoComplete="given-name"
              maxLength={PROFILE_FIELD_LIMITS.name}
              value={form.name}
              onChange={update('name')}
              invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'profile-name-error' : undefined}
              required
            />
            {errors.name ? (
              <p id="profile-name-error" className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.name)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label className="sr-only" htmlFor="profile-surname">{t('surname')}</Label>
            <Input
          placeholder={t('surname')}
              id="profile-surname"
              autoComplete="family-name"
              maxLength={PROFILE_FIELD_LIMITS.surname}
              value={form.surname}
              onChange={update('surname')}
              invalid={Boolean(errors.surname)}
              aria-describedby={errors.surname ? 'profile-surname-error' : undefined}
              required
            />
            {errors.surname ? (
              <p id="profile-surname-error" className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.surname)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="sr-only" htmlFor="profile-job">{t('job')}</Label>
            <Input
          placeholder={t('job')}
              id="profile-job"
              autoComplete="organization-title"
              maxLength={PROFILE_FIELD_LIMITS.job}
              value={form.job}
              onChange={update('job')}
              invalid={Boolean(errors.job)}
              aria-describedby={errors.job ? 'profile-job-error' : undefined}
              required
            />
            {errors.job ? (
              <p id="profile-job-error" className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.job)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="sr-only" htmlFor="profile-organization">{t('organizationShort')}</Label>
            <Input
          placeholder={t('organizationShort')}
              id="profile-organization"
              list="profile-organizations"
              autoComplete="organization"
              maxLength={PROFILE_FIELD_LIMITS.organization}
              value={form.organization}
              onChange={update('organization')}
              invalid={Boolean(errors.organization)}
              aria-describedby={errors.organization ? 'profile-organization-error' : undefined}
              required
            />
            <datalist id="profile-organizations">
              {organizations.map((organization) => (
                <option key={organization} value={organization} />
              ))}
            </datalist>
            {errors.organization ? (
              <p id="profile-organization-error" className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.organization)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="sr-only" htmlFor="profile-education">{t('education')}</Label>
            <EducationSelect
              id="profile-education"
              value={form.education}
              onChange={(education) => {
                setForm((current) => ({ ...current, education }));
                setErrors((current) => ({ ...current, education: undefined }));
              }}
              invalid={Boolean(errors.education)}
              aria-describedby={
                errors.education
                  ? 'profile-education-error profile-education-help'
                  : 'profile-education-help'
              }
            />
            <p id="profile-education-help" className="text-xs text-[var(--color-text-muted)]">
              {t('educationHint')}
            </p>
            {errors.education ? (
              <p id="profile-education-error" className="text-xs text-[var(--color-danger)]">
                {validationMessage(errors.education)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="sr-only" htmlFor="profile-phone">
              {t('phone')}
            </Label>
            <PhoneInput
              id="profile-phone"
              optional={!phoneRequired}
              countryOptions={countryOptions}
              value={form.phone}
              onChange={(phone) => {
                setForm((current) => ({ ...current, phone }));
                setErrors((current) => ({ ...current, phone: undefined }));
              }}
              invalid={Boolean(errors.phone)}
              describedBy={
                errors.phone ? 'profile-phone-error profile-phone-help' : 'profile-phone-help'
              }
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
            <p aria-hidden="true" className="text-sm text-[var(--color-text-muted)] sm:col-span-2">
              {message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
