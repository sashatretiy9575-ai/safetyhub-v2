'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

const errorMessages: Record<string, string> = {
  LAST_ACTIVE_ADMIN_PROTECTED: 'Нельзя удалить последнего администратора.',
  CANNOT_DELETE_SELF: 'Нельзя удалить собственный аккаунт.',
  RATE_LIMITED: 'Слишком много действий подряд. Подождите немного и повторите.',
};

const skipReasons: Record<string, string> = {
  ACCOUNT_HAS_PENDING_AUTH_OPERATIONS: 'по аккаунту ещё выполняется операция; повторите позже',
  TOMBSTONE_MISSING: 'не удалось подготовить очистку файлов',
  ALREADY_ABSENT: 'аккаунт уже удалён',
  USER_NOT_FOUND: 'аккаунт не найден',
  ACCOUNT_PURGE_FAILED: 'сервер отказал в удалении',
};

/**
 * Deletes one account from the directory. The employee list can already
 * delete people who took a test; somebody who only registered never appeared
 * there, so there was no way to remove them at all.
 */
export function AccountPurgeButton({ userId, label }: { userId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  const purge = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 10 || busy) return;
    setBusy(true);
    setMessage('');
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const result = await clientRequest(
        '/api/admin/users/purge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userIds: [userId],
            reason: trimmed,
            confirmation: 'УДАЛИТЬ',
            idempotencyKey: idempotencyKey.current,
          }),
        },
        { timeoutMs: 120_000 },
      );
      const payload = await readClientResponseJson<{
        error?: string;
        items?: { id: string; status: string; reason: string | null }[];
      }>(result.response);
      if (!result.ok || !payload?.items) {
        if (payload?.error === 'IDEMPOTENCY_KEY_REUSED') idempotencyKey.current = null;
        setMessage(
          errorMessages[payload?.error ?? ''] ??
            clientRequestMessage(
              result.ok ? null : result.error,
              'Удаление не выполнено. Обновите страницу.',
            ),
        );
        return;
      }
      const item = payload.items.find((entry) => entry.id === userId);
      if (!item || item.status === 'skipped') {
        setMessage(
          `Аккаунт не удалён: ${skipReasons[item?.reason ?? ''] ?? item?.reason ?? 'причина неизвестна'}.`,
        );
        return;
      }
      setDone(true);
      setMessage('Аккаунт удалён.');
      router.refresh();
    } catch (error) {
      setMessage(clientRequestMessage(error, 'Удаление не выполнено. Обновите страницу.'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p role="status" className="text-sm text-[var(--color-text-muted)]">
        {message}
      </p>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
        onClick={() => setOpen(true)}
      >
        <Trash size={18} aria-hidden="true" />
        Удалить аккаунт
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-[var(--color-danger)]/40 p-3 sm:max-w-md">
      <p className="text-sm font-semibold">Удалить аккаунт {label} без восстановления?</p>
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        maxLength={500}
        placeholder="Причина, не короче 10 символов"
        disabled={busy}
        aria-label="Причина удаления"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-11"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setMessage('');
          }}
        >
          Отмена
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger)]/90"
          disabled={busy || reason.trim().length < 10}
          onClick={() => void purge()}
        >
          {busy ? 'Удаляем…' : 'Удалить без восстановления'}
        </Button>
      </div>
      {message ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
