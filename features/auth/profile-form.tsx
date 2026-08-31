'use client';

import { useEffect, useState } from 'react';
import { PencilSimple, X } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import {
  normalizeProfileValues,
  PROFILE_FIELD_LIMITS,
  validateProfileValues,
  type ProfileField,
  type ProfileValues,
} from '@/features/profile/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type OrganizationResponse = { organizations?: string[] };
type UpdateResponse = {
  profile?: ProfileValues;
};

export function ProfileForm({ initial }: { initial: ProfileValues }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [savedProfile, setSavedProfile] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
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
    const validation = validateProfileValues(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      setMessage('Проверьте обязательные поля.');
      return;
    }

    const normalized = normalizeProfileValues(form);
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
        setMessage(clientRequestMessage(result.error, 'Не удалось сохранить профиль.'));
        return;
      }
      const saved = payload?.profile ? normalizeProfileValues(payload.profile) : normalized;
      setForm(saved);
      setSavedProfile(saved);
      setEditing(false);
      setMessage('Данные профиля сохранены.');
      router.refresh();
    } catch (requestError) {
      setMessage(clientRequestMessage(requestError, 'Не удалось сохранить профиль.'));
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

  return (
    <div className="space-y-3">
      {!editing ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            <PencilSimple size={17} /> Изменить данные
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
            <Label htmlFor="profile-name">Имя</Label>
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
              <p className="text-xs text-[var(--color-danger)]">{errors.name}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="profile-surname">Фамилия</Label>
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
              <p className="text-xs text-[var(--color-danger)]">{errors.surname}</p>
            ) : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="profile-job">Должность</Label>
            <Input
              id="profile-job"
              autoComplete="organization-title"
              maxLength={PROFILE_FIELD_LIMITS.job}
              value={form.job}
              onChange={update('job')}
              invalid={Boolean(errors.job)}
              required
            />
            {errors.job ? <p className="text-xs text-[var(--color-danger)]">{errors.job}</p> : null}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="profile-organization">Компания</Label>
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
              <p className="text-xs text-[var(--color-danger)]">{errors.organization}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancelEditing}>
              <X size={16} /> Отмена
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
