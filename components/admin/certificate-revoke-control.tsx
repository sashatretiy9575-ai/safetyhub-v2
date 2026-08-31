'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function CertificateRevokeControl({ certificateId }: { certificateId: string }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest(`/api/admin/certificates/${certificateId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (result.ok) {
        router.refresh();
        setExpanded(false);
        setReason('');
        return;
      }
      const payload = await readClientResponseJson<{ error?: string }>(result.response);
      setError(
        payload?.error === 'CAPABILITY_REQUIRED'
          ? 'Недостаточно полномочий для отзыва сертификата.'
          : clientRequestMessage(result.error, 'Не удалось отозвать сертификат.'),
      );
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось отозвать сертификат.'));
    } finally {
      setBusy(false);
    }
  };

  if (!expanded) {
    return (
      <Button size="sm" variant="danger" onClick={() => setExpanded(true)}>
        Отозвать
      </Button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full space-y-2 rounded-lg border border-[var(--color-danger)] p-3"
    >
      <Label htmlFor={`revoke-reason-${certificateId}`}>Причина отзыва</Label>
      <Textarea
        id={`revoke-reason-${certificateId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        minLength={3}
        maxLength={500}
        required
        autoFocus
      />
      {error && (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={busy}>
          {busy ? 'Отзываем...' : 'Подтвердить отзыв'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setExpanded(false);
            setError('');
          }}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}
