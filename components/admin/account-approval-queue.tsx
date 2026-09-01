'use client';

/* eslint-disable @next/next/no-img-element */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { requestAdminNotificationRefresh } from '@/components/admin/admin-notification-inbox';
import type { AdminAccountApprovalItem } from '@/features/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

type Decision = 'approved' | 'rejected';
type DecisionResponse = { approvalState?: Decision; error?: string };

const errorMessages: Record<string, string> = {
  ACCOUNT_APPROVAL_NOT_PENDING: 'Заявка уже была рассмотрена. Обновите очередь.',
  ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN:
    'Администратор не может подтверждать собственную заявку.',
  IDEMPOTENCY_KEY_REUSED: 'Эта операция уже была отправлена с другими данными. Обновите очередь.',
  RATE_LIMITED: 'Слишком много действий подряд. Подождите немного и повторите.',
};

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
  return `${item.name} ${item.surname}`.trim() || 'Без имени';
}

export function AccountApprovalQueue({ items }: { items: AdminAccountApprovalItem[] }) {
  const router = useRouter();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const operationKeys = useRef(new Map<string, string>());

  const decide = async (item: AdminAccountApprovalItem, decision: Decision) => {
    const reason = (reasons[item.id] ?? '').trim();
    if (decision === 'rejected' && reason.length < 3) {
      setMessage('Для отказа укажите понятный комментарий не короче трёх символов.');
      return;
    }

    const operationKey = `${item.id}:${decision}:${reason}`;
    const idempotencyKey = operationKeys.current.get(operationKey) ?? crypto.randomUUID();
    operationKeys.current.set(operationKey, idempotencyKey);
    setBusyId(item.id);
    setMessage('');

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
      const payload = await readClientResponseJson<DecisionResponse>(result.response);
      if (!result.ok) {
        const code = payload && typeof payload.error === 'string' ? payload.error : '';
        setMessage(
          errorMessages[code] ??
            clientRequestMessage(result.error, 'Не удалось сохранить решение. Попробуйте ещё раз.'),
        );
        return;
      }
      if (payload?.approvalState !== decision) {
        setMessage('Сервер вернул неполный результат. Обновите очередь перед повтором.');
        return;
      }
      operationKeys.current.delete(operationKey);
      setReasons((current) => ({ ...current, [item.id]: '' }));
      setMessage(
        decision === 'approved'
          ? 'Доступ к обучению подтверждён.'
          : 'Заявка возвращена на уточнение.',
      );
      requestAdminNotificationRefresh();
      router.refresh();
    } catch (error) {
      setMessage(clientRequestMessage(error, 'Не удалось сохранить решение. Попробуйте ещё раз.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const busy = busyId === item.id;
        const label = fullName(item);
        return (
          <article
            key={item.id}
            className="grid gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:grid-cols-[5.25rem_minmax(0,1fr)] sm:p-5"
          >
            <div className="flex items-start gap-3 sm:block">
              {item.avatarAvailable ? (
                <img
                  src={`/api/admin/attestations/avatar/${item.id}`}
                  alt={`Фото профиля: ${label}`}
                  className="size-20 shrink-0 rounded-xl border border-[var(--color-border)] object-cover sm:size-[5.25rem]"
                />
              ) : (
                <div className="grid size-20 shrink-0 place-items-center rounded-xl border border-dashed text-center text-xs text-[var(--color-text-muted)] sm:size-[5.25rem]">
                  Фото
                  <br />
                  не загружено
                </div>
              )}
              <div className="min-w-0 sm:hidden">
                <h2 className="font-display text-lg font-bold break-words">{label}</h2>
                <p className="text-sm break-all text-[var(--color-text-muted)]">
                  {item.email ?? 'Вход по логину и паролю'}
                </p>
              </div>
            </div>

            <div className="min-w-0 space-y-4">
              <div className="hidden sm:block">
                <h2 className="font-display text-lg font-bold break-words">{label}</h2>
                <p className="text-sm break-all text-[var(--color-text-muted)]">
                  {item.email ?? 'Вход по логину и паролю'}
                </p>
              </div>

              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-semibold text-[var(--color-text-muted)]">
                    Должность
                  </dt>
                  <dd className="break-words">{item.job || 'Не указана'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--color-text-muted)]">Компания</dt>
                  <dd className="break-words">{item.organization || 'Не указана'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--color-text-muted)]">Телефон</dt>
                  <dd>
                    {item.phoneE164 ?? 'Не указан'}
                    {item.phoneCountryIso2 ? ` · ${item.phoneCountryIso2}` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--color-text-muted)]">
                    Контрольный срок
                  </dt>
                  <dd>
                    <time dateTime={item.dueAt}>{dateTime(item.dueAt)}</time>
                  </dd>
                </div>
              </dl>

              <p className="text-xs text-[var(--color-text-muted)]">
                Заявка отправлена:{' '}
                <time dateTime={item.requestedAt}>{dateTime(item.requestedAt)}</time>.
              </p>

              <div className="grid gap-2 border-t border-[var(--color-border)] pt-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-[var(--color-text-muted)]">
                    Комментарий при отказе
                  </span>
                  <Textarea
                    value={reasons[item.id] ?? ''}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                    }
                    maxLength={500}
                    rows={2}
                    placeholder="Например: уточните название компании."
                    disabled={busy}
                  />
                </label>
                <div className="flex flex-wrap content-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void decide(item, 'approved')}
                  >
                    Подтвердить доступ
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || (reasons[item.id] ?? '').trim().length < 3}
                    onClick={() => void decide(item, 'rejected')}
                  >
                    Вернуть на уточнение
                  </Button>
                </div>
              </div>
            </div>
          </article>
        );
      })}
      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-muted)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
