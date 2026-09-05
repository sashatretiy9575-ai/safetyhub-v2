'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Button } from '@/components/ui/button';

/** Withdraws a pending admin appointment: the person has not signed in yet. */
export function PendingGrantRevokeButton({ email }: { email: string }) {
  const router = useRouter();
  const idempotencyKey = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest('/api/admin/operators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: 'participant',
          reason: 'Отмена отложенного назначения администратора',
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const payload = await readClientResponseJson<{ error?: string }>(result.response);
      if (!result.ok || !payload) {
        setError(
          result.ok
            ? 'Сервер вернул неполный ответ.'
            : clientRequestMessage(result.error, 'Не удалось отменить назначение.'),
        );
        return;
      }
      idempotencyKey.current = crypto.randomUUID();
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось отменить назначение.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revoke()}>
        {busy ? 'Отменяем…' : 'Отменить'}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
