'use client';

import { useState } from 'react';
import { Trash } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clientRequest, clientRequestMessage } from '@/lib/client-request';

const CONFIRMATION = 'УДАЛИТЬ';

export function AccountDeletion() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const removeAccount = async () => {
    if (busy || confirmation !== CONFIRMATION) return;
    setBusy(true);
    setMessage('Удаляем аккаунт и связанные данные…');
    try {
      const result = await clientRequest('/api/profile/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
        cache: 'no-store',
      });
      if (!result.ok) {
        setMessage(clientRequestMessage(result.error, 'Не удалось удалить аккаунт.'));
        return;
      }
      window.location.assign('/auth/login?deleted=1');
    } catch (error) {
      setMessage(clientRequestMessage(error, 'Не удалось удалить аккаунт.'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" size="sm" variant="danger" onClick={() => setOpen(true)}>
        <Trash size={17} /> Удалить аккаунт
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border border-[var(--color-danger)] p-4">
      <div>
        <h2 className="font-display text-lg font-bold">Необратимое удаление</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Будут удалены профиль, фотография, все попытки, результаты, сертификаты и связанный аудит.
          Проверка сертификатов по QR перестанет работать. Уже скачанные на другие устройства PDF
          физически удалить невозможно.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="account-deletion-confirmation">
          Для подтверждения введите {CONFIRMATION}
        </Label>
        <Input
          id="account-deletion-confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          disabled={busy}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="danger"
          disabled={busy || confirmation !== CONFIRMATION}
          onClick={removeAccount}
        >
          <Trash size={17} /> {busy ? 'Удаляем…' : 'Удалить навсегда'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setConfirmation('');
            setMessage('');
          }}
        >
          Отмена
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
