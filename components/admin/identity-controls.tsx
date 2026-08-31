'use client';

import { useState } from 'react';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import type { VerifiedIdentity } from '@/features/identity/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type IdentityFields = {
  name: string;
  surname: string;
  job: string;
  organization: string;
};

const errorMessages: Record<string, string> = {
  IDENTITY_NOT_VERIFIED: 'Подтверждение уже отсутствует.',
  INVALID_REQUEST: 'Проверьте заполненные поля.',
};

export function IdentityControls({
  userId,
  profile,
  initialIdentity,
}: {
  userId: string;
  profile: { name: string; surname: string; job: string };
  initialIdentity: VerifiedIdentity;
}) {
  const [identity, setIdentity] = useState<VerifiedIdentity>(initialIdentity);
  const [fields, setFields] = useState<IdentityFields>(
    initialIdentity.status === 'unverified'
      ? { ...profile, organization: '' }
      : {
          name: initialIdentity.name,
          surname: initialIdentity.surname,
          job: initialIdentity.job,
          organization: initialIdentity.organization,
        },
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const patch = async (body: Record<string, string>) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await clientRequest(`/api/admin/users/${userId}/identity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await readClientResponseJson<VerifiedIdentity | { error?: string }>(
        result.response,
      );
      if (!result.ok) {
        const code = payload && 'error' in payload ? payload.error : undefined;
        setMessage(
          result.error.kind === 'http' && !result.error.retryable
            ? (code && errorMessages[code]) || 'Не удалось изменить подтверждение.'
            : clientRequestMessage(result.error, 'Не удалось изменить подтверждение.'),
        );
        return;
      }
      if (!payload || !('status' in payload)) {
        setMessage('Сервер вернул неполный ответ. Обновите страницу и проверьте результат.');
        return;
      }
      setIdentity(payload);
      setMessage(body.action === 'verify' ? 'Личность подтверждена.' : 'Подтверждение отозвано.');
      setReason('');
    } catch (requestError) {
      setMessage(clientRequestMessage(requestError, 'Не удалось изменить подтверждение.'));
    } finally {
      setBusy(false);
    }
  };

  const update = (field: keyof IdentityFields) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setFields((current) => ({ ...current, [field]: event.target.value }));

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold">Личность для сертификата</h4>
        <span className="text-xs font-semibold text-[var(--color-text-muted)]">
          {identity?.status === 'verified'
            ? `Подтверждена · v${identity.version}`
            : identity?.status === 'revoked'
              ? 'Отозвана'
              : 'Не подтверждена'}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`identity-name-${userId}`}>Имя</Label>
          <Input id={`identity-name-${userId}`} value={fields.name} onChange={update('name')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`identity-surname-${userId}`}>Фамилия</Label>
          <Input
            id={`identity-surname-${userId}`}
            value={fields.surname}
            onChange={update('surname')}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`identity-job-${userId}`}>Должность</Label>
          <Input id={`identity-job-${userId}`} value={fields.job} onChange={update('job')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`identity-organization-${userId}`}>Организация</Label>
          <Input
            id={`identity-organization-${userId}`}
            value={fields.organization}
            onChange={update('organization')}
          />
        </div>
      </div>
      <Button size="sm" disabled={busy} onClick={() => void patch({ action: 'verify', ...fields })}>
        {identity?.status === 'verified' ? 'Подтвердить заново' : 'Подтвердить'}
      </Button>
      {identity?.status === 'verified' && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Причина отзыва личности"
            placeholder="Причина отзыва"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            className="text-[var(--color-danger)]"
            disabled={busy || reason.trim().length < 2}
            onClick={() => void patch({ action: 'revoke', reason })}
          >
            Отозвать
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {message}
        </p>
      )}
    </div>
  );
}
