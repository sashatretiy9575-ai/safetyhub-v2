'use client';

import { Trash } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { AdminLearningHistory, AdminLearningHistoryDeletion } from '@/features/admin/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

export function LearningHistoryControl({
  userId,
  userLabel,
  initialHistory = null,
  onDeleted,
}: {
  userId: string;
  userLabel: string;
  initialHistory?: AdminLearningHistory | null;
  onDeleted?: () => void;
}) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [history, setHistory] = useState<AdminLearningHistory | null>(initialHistory);
  const [loading, setLoading] = useState(!initialHistory);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialHistory?.user.id === userId) {
      setHistory(initialHistory);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void clientRequest(
      `/api/admin/users/${userId}/learning-history`,
      {},
      { signal: controller.signal },
    )
      .then(async (result) => {
        if (!result.ok) throw result.error;
        const payload = await readClientResponseJson<AdminLearningHistory>(result.response);
        if (!payload?.counts) throw new Error('LEARNING_HISTORY_CONTRACT_INVALID');
        setHistory(payload);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setMessage(clientRequestMessage(error, 'Не удалось загрузить учебную историю.'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [initialHistory, userId]);

  const remove = async () => {
    if (reason.trim().length < 10 || confirmation !== 'УДАЛИТЬ') return;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      const result = await clientRequest(`/api/admin/users/${userId}/learning-history`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reason.trim(),
          confirmation,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const payload = await readClientResponseJson<
        AdminLearningHistoryDeletion & { error?: string }
      >(result.response);
      if (!result.ok || !payload?.counts)
        throw new Error(payload?.error ?? 'LEARNING_HISTORY_DELETE_FAILED');
      setHistory((current) =>
        current
          ? {
              ...current,
              counts: {
                attempts: 0,
                startedAttempts: 0,
                attestations: 0,
                activeCertificates: 0,
                revokedCertificates: 0,
              },
              lastActivityAt: null,
              deletable: false,
            }
          : null,
      );
      setConfirming(false);
      setMessage(
        payload.deleted
          ? 'Учебная история удалена. Аккаунт и профиль сохранены.'
          : 'Учебная история уже была пуста.',
      );
      idempotencyKey.current = crypto.randomUUID();
      onDeleted?.();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'LEARNING_HISTORY_ALREADY_DELETED') {
        setHistory((current) =>
          current
            ? {
                ...current,
                counts: {
                  attempts: 0,
                  startedAttempts: 0,
                  attestations: 0,
                  activeCertificates: 0,
                  revokedCertificates: 0,
                },
                lastActivityAt: null,
                deletable: false,
              }
            : null,
        );
        setConfirming(false);
        setMessage('Учебная история уже была удалена другим запросом. Аккаунт сохранён.');
      } else {
        setFailed(true);
        setMessage(
          code === 'LEARNING_HISTORY_TARGET_NOT_ALLOWED'
            ? 'Для этой учётной записи удаление учебной истории запрещено.'
            : code === 'LEARNING_HISTORY_DELETE_CONFLICT'
              ? 'История изменилась во время удаления. Обновите данные и повторите операцию.'
              : clientRequestMessage(
                  error,
                  'Не удалось удалить учебную историю. Безопасно повторите запрос.',
                ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const total = history
    ? history.counts.attempts +
      history.counts.attestations +
      history.counts.activeCertificates +
      history.counts.revokedCertificates
    : 0;

  return (
    <section className="space-y-3 border-t border-[var(--color-border)] pt-4">
      <div>
        <h3 className="text-base font-bold">Учебная история</h3>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Удаление не затрагивает аккаунт, профиль, роль или аудит.
        </p>
      </div>
      {loading ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          Загружаем историю…
        </p>
      ) : history ? (
        <dl className="grid grid-cols-2 gap-2 rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--color-text-subtle)]">Попытки</dt>
            <dd className="font-black tabular-nums">{history.counts.attempts}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-subtle)]">Незавершённые</dt>
            <dd className="font-black tabular-nums">{history.counts.startedAttempts}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-subtle)]">Аттестации</dt>
            <dd className="font-black tabular-nums">{history.counts.attestations}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-subtle)]">Сертификаты</dt>
            <dd className="font-black tabular-nums">{history.counts.activeCertificates}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-subtle)]">Отозванные</dt>
            <dd className="font-black tabular-nums">{history.counts.revokedCertificates}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-text-subtle)]">Последняя активность</dt>
            <dd className="font-semibold">
              {history.lastActivityAt
                ? new Date(history.lastActivityAt).toLocaleDateString('ru-RU')
                : '—'}
            </dd>
          </div>
        </dl>
      ) : null}

      {history?.deletable && total > 0 && !confirming ? (
        <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
          <Trash aria-hidden="true" />
          Удалить всю учебную историю
        </Button>
      ) : null}
      {confirming ? (
        <div className="space-y-3 rounded-xl border border-[var(--color-danger)] p-4">
          <p className="text-sm font-bold text-[var(--color-danger)]">
            Будут удалены все попытки, аттестации и сертификаты пользователя {userLabel}. Старые
            QR-коды перестанут работать.
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">
            Попытки: {history?.counts.attempts ?? 0} (незавершённые:{' '}
            {history?.counts.startedAttempts ?? 0}); аттестации: {history?.counts.attestations ?? 0}
            ; сертификаты: {history?.counts.activeCertificates ?? 0}; отозванные сертификаты:{' '}
            {history?.counts.revokedCertificates ?? 0}.
          </p>
          <div className="space-y-1">
            <Label htmlFor={`history-reason-${userId}`}>Причина, минимум 10 символов</Label>
            <Textarea
              id={`history-reason-${userId}`}
              minLength={10}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`history-confirm-${userId}`}>Введите УДАЛИТЬ</Label>
            <Input
              id={`history-confirm-${userId}`}
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={busy || reason.trim().length < 10 || confirmation !== 'УДАЛИТЬ'}
              onClick={() => void remove()}
            >
              {busy ? 'Удаляем…' : 'Удалить без восстановления'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setReason('');
                setConfirmation('');
              }}
            >
              Отмена
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p
          role={failed ? 'alert' : 'status'}
          className={
            failed ? 'text-sm text-[var(--color-danger)]' : 'text-sm text-[var(--color-text-muted)]'
          }
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
