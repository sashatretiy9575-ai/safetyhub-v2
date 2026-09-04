'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const FAILURES: Record<string, string> = {
  LAST_ACTIVE_ADMIN_PROTECTED: 'Это последний администратор — снять права нельзя.',
  SUPERADMIN_DEMOTION_FORBIDDEN: 'У этого аккаунта основной доступ, снять его отсюда нельзя.',
  CANNOT_CHANGE_OWN_ROLE: 'Свои собственные права изменить нельзя.',
  ACCOUNT_UNAVAILABLE: 'Аккаунт заблокирован или удаляется.',
};

export function OperatorRevokeButton({ userId, label }: { userId: string; label: string }) {
  const router = useRouter();
  const idempotencyKey = useRef(crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest('/api/admin/operators', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          role: 'participant',
          reason: reason.trim(),
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const payload = await readClientResponseJson<{ error?: string }>(result.response);
      if (!result.ok || !payload) {
        const known = payload?.error ? FAILURES[payload.error] : undefined;
        setError(
          known ??
            (result.ok
              ? 'Сервер вернул неполный ответ.'
              : clientRequestMessage(result.error, 'Не удалось снять доступ.')),
        );
        return;
      }
      idempotencyKey.current = crypto.randomUUID();
      setOpen(false);
      setReason('');
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось снять доступ.'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Снять доступ
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="w-full space-y-2 rounded-xl border p-3 sm:max-w-md">
      <Label htmlFor={`operator-revoke-${userId}`}>
        Причина: почему {label} больше не администратор
      </Label>
      <Textarea
        id={`operator-revoke-${userId}`}
        required
        minLength={10}
        maxLength={500}
        autoFocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={busy}>
          {busy ? 'Снимаем…' : 'Подтвердить'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError('');
          }}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}
