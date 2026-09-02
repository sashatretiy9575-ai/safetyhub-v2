'use client';

/* eslint-disable @next/next/no-img-element */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { requestAdminNotificationRefresh } from '@/components/admin/admin-notification-inbox';
import type { AdminAccountApprovalItem } from '@/features/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

type Decision = 'approved' | 'rejected';

const decisionResponseSchema = z
  .object({
    userId: z.string().uuid(),
    approvalState: z.enum(['approved', 'rejected']),
    decidedAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict();
const errorResponseSchema = z.object({ error: z.string().min(1).optional() }).strict();

const errorMessages: Record<string, string> = {
  ACCOUNT_APPROVAL_NOT_PENDING: 'Заявка уже была рассмотрена. Очередь обновлена.',
  ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN:
    'Администратор не может подтверждать собственную заявку.',
  IDEMPOTENCY_KEY_REUSED: 'Эта операция уже была отправлена с другими данными. Очередь обновлена.',
  RATE_LIMITED: 'Слишком много действий подряд. Подождите немного и повторите.',
};

const unconfirmedResultMessage =
  'Решение могло сохраниться, но ответ сервера не удалось подтвердить. Очередь обновлена; перед повтором проверьте заявку.';

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'дата недоступна';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Oral',
  }).format(date);
}

function fullName(item: AdminAccountApprovalItem) {
  return `${item.name} ${item.surname}`.trim() || item.username || 'Без имени';
}

function accountIdentifier(item: AdminAccountApprovalItem) {
  return item.username ? `Логин: ${item.username}` : (item.email ?? 'Вход по логину и паролю');
}

function isMinimalZhApplication(item: AdminAccountApprovalItem) {
  return Boolean(item.username) && item.email === null;
}

export function AccountApprovalQueue({ items }: { items: AdminAccountApprovalItem[] }) {
  const router = useRouter();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rejectionId, setRejectionId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [operationDiagnostic, setOperationDiagnostic] = useState('');
  const operationKeys = useRef(new Map<string, string>());
  const busyIdsRef = useRef(new Set<string>());
  const resolvedIdsRef = useRef(new Set<string>());

  const refreshQueue = () => {
    requestAdminNotificationRefresh();
    router.refresh();
  };

  const reportUnconfirmedResult = (idempotencyKey: string) => {
    setMessage(unconfirmedResultMessage);
    setOperationDiagnostic(idempotencyKey);
    refreshQueue();
  };

  const decide = async (item: AdminAccountApprovalItem, decision: Decision) => {
    const reason = (reasons[item.id] ?? '').trim();
    if (decision === 'rejected' && reason.length < 3) {
      setMessage('Для отказа укажите понятный комментарий не короче трёх символов.');
      setOperationDiagnostic('');
      return;
    }
    if (busyIdsRef.current.has(item.id) || resolvedIdsRef.current.has(item.id)) return;

    const operationKey = `${item.id}:${decision}:${reason}`;
    const idempotencyKey = operationKeys.current.get(operationKey) ?? crypto.randomUUID();
    operationKeys.current.set(operationKey, idempotencyKey);
    busyIdsRef.current.add(item.id);
    setBusyIds(new Set(busyIdsRef.current));
    setMessage('');
    setOperationDiagnostic('');

    try {
      const result = await clientRequest(`/api/admin/account-approvals/${item.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          decision,
          ...(decision === 'rejected' ? { reason } : {}),
        }),
      });
      const payload = await readClientResponseJson<unknown>(result.response);

      if (!result.ok) {
        const parsedError = errorResponseSchema.safeParse(payload);
        const code = parsedError.success ? (parsedError.data.error ?? '') : '';
        setMessage(
          errorMessages[code] ??
            clientRequestMessage(result.error, 'Не удалось сохранить решение. Попробуйте ещё раз.'),
        );
        setOperationDiagnostic(idempotencyKey);
        refreshQueue();
        return;
      }

      const receipt = decisionResponseSchema.safeParse(payload);
      if (
        !receipt.success ||
        receipt.data.userId !== item.id ||
        receipt.data.approvalState !== decision
      ) {
        reportUnconfirmedResult(idempotencyKey);
        return;
      }

      operationKeys.current.delete(operationKey);
      // Keep the resolved row non-actionable until the server refresh removes
      // it. Otherwise a fast second click can create a new idempotency key
      // during the short window before refreshed props arrive.
      resolvedIdsRef.current.add(item.id);
      setResolvedIds(new Set(resolvedIdsRef.current));
      setReasons((current) => ({ ...current, [item.id]: '' }));
      setRejectionId((current) => (current === item.id ? null : current));
      setMessage(
        decision === 'approved'
          ? 'Доступ к обучению подтверждён.'
          : 'Заявка возвращена на уточнение.',
      );
      refreshQueue();
    } catch (error) {
      setMessage(clientRequestMessage(error, 'Не удалось сохранить решение. Попробуйте ещё раз.'));
      setOperationDiagnostic(idempotencyKey);
      refreshQueue();
    } finally {
      busyIdsRef.current.delete(item.id);
      setBusyIds(new Set(busyIdsRef.current));
    }
  };

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const busy = busyIds.has(item.id);
        const resolved = resolvedIds.has(item.id);
        const actionDisabled = busy || resolved;
        const label = fullName(item);
        const minimalZh = isMinimalZhApplication(item);
        const requestingRejection = rejectionId === item.id;
        return (
          <article
            key={item.id}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm transition-all hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)]"
          >
            <div className="grid gap-4 sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-5">
              {item.avatarAvailable ? (
                <img
                  src={`/api/admin/attestations/avatar/${item.id}`}
                  alt={`Фото профиля: ${label}`}
                  className="size-14 rounded-2xl border border-[var(--color-border)] object-cover sm:size-16"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="grid size-14 place-items-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-xl font-black text-[var(--color-primary)] sm:size-16"
                >
                  {label.charAt(0).toUpperCase()}
                </div>
              )}

            <div className="min-w-0 space-y-3">
              <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-bold break-words">{label}</h2>
                  <p className="text-sm break-all text-[var(--color-text-muted)]">
                    {accountIdentifier(item)}
                  </p>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">
                  До <time dateTime={item.dueAt}>{dateTime(item.dueAt)}</time>
                </p>
              </header>

              {minimalZh ? (
                <p className="text-sm text-[var(--color-text-muted)]">
                  ZH · заявка без контактных данных
                </p>
              ) : (
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-text-muted)]">
                  {item.job ? (
                    <div className="flex gap-1">
                      <dt className="font-semibold">Должность:</dt>
                      <dd className="break-words">{item.job}</dd>
                    </div>
                  ) : null}
                  {item.organization ? (
                    <div className="flex gap-1">
                      <dt className="font-semibold">Компания:</dt>
                      <dd className="break-words">{item.organization}</dd>
                    </div>
                  ) : null}
                  {item.phoneE164 ? (
                    <div className="flex gap-1">
                      <dt className="font-semibold">Телефон:</dt>
                      <dd>
                        {item.phoneE164}
                        {item.phoneCountryIso2 ? ` · ${item.phoneCountryIso2}` : ''}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              )}

              <p className="text-xs text-[var(--color-text-muted)]">
                Заявка отправлена:{' '}
                <time dateTime={item.requestedAt}>{dateTime(item.requestedAt)}</time>.
              </p>

              {requestingRejection ? (
                <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-[var(--color-text-muted)]">
                      Что нужно уточнить
                    </span>
                    <Textarea
                      value={reasons[item.id] ?? ''}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                      }
                      maxLength={500}
                      rows={2}
                      placeholder="Например: уточните название компании."
                      disabled={actionDisabled}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={actionDisabled}
                      onClick={() => {
                        setRejectionId(null);
                        setMessage('');
                        setOperationDiagnostic('');
                      }}
                    >
                      Отмена
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actionDisabled || (reasons[item.id] ?? '').trim().length < 3}
                      onClick={() => void decide(item, 'rejected')}
                    >
                      Вернуть на уточнение
                    </Button>
                  </div>
                </div>
              ) : resolved ? (
                <p
                  role="status"
                  className="border-t border-[var(--color-border)] pt-3 text-sm text-[var(--color-text-muted)]"
                >
                  Решение сохранено. Обновляем очередь…
                </p>
              ) : (
                <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={actionDisabled}
                    onClick={() => void decide(item, 'approved')}
                  >
                    Подтвердить доступ
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={actionDisabled}
                    onClick={() => {
                      setRejectionId(item.id);
                      setMessage('');
                      setOperationDiagnostic('');
                    }}
                  >
                    Вернуть на уточнение
                  </Button>
                </div>
              )}
            </div>
          </div>
        </article>
        );
      })}
      {message ? (
        <div
          role="status"
          aria-live="polite"
          className="space-y-1 px-1 py-3 text-sm text-[var(--color-text-muted)]"
        >
          <p>{message}</p>
          {operationDiagnostic ? (
            <p className="text-xs">
              Код операции: <code className="font-mono">{operationDiagnostic}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
