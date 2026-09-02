'use client';

/* eslint-disable @next/next/no-img-element */

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { requestAdminNotificationRefresh } from '@/components/admin/admin-notification-inbox';
import type { AdminAccountApprovalItem } from '@/features/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

type Decision = 'approved' | 'rejected';

const QUICK_REASONS = [
  'Фото нечёткое или не соответствует требованиям',
  'Уточните верное название компании',
  'Неверно указан номер телефона',
  'Сотрудник отсутствует в списках компании',
];

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
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'oldest' | 'newest'>('oldest');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const operationKeys = useRef(new Map<string, string>());
  const busyIdsRef = useRef(new Set<string>());
  const resolvedIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshQueue = (immediate = false) => {
    requestAdminNotificationRefresh();
    if (immediate) {
      router.refresh();
      return;
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      router.refresh();
    }, 1500);
  };

  const reportUnconfirmedResult = (idempotencyKey: string) => {
    setMessage(unconfirmedResultMessage);
    setOperationDiagnostic(idempotencyKey);
    refreshQueue(true);
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

  const visibleItems = useMemo(() => {
    return items
      .filter((item) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        const name = `${item.name} ${item.surname}`.toLowerCase();
        const email = (item.email ?? '').toLowerCase();
        const org = (item.organization ?? '').toLowerCase();
        const username = (item.username ?? '').toLowerCase();
        return name.includes(q) || email.includes(q) || org.includes(q) || username.includes(q);
      })
      .sort((a, b) => {
        const timeA = new Date(a.requestedAt).getTime();
        const timeB = new Date(b.requestedAt).getTime();
        return sortOrder === 'oldest' ? timeA - timeB : timeB - timeA;
      });
  }, [items, search, sortOrder]);

  const approveSelected = async () => {
    if (selectedIds.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    const toApprove = visibleItems.filter(
      (item) =>
        selectedIds.has(item.id) &&
        !busyIdsRef.current.has(item.id) &&
        !resolvedIdsRef.current.has(item.id),
    );
    for (const item of toApprove) {
      await decide(item, 'approved');
    }
    setSelectedIds(new Set());
    setBulkBusy(false);
  };

  const toggleSelectAll = () => {
    const selectable = visibleItems.filter((i) => !resolvedIds.has(i.id));
    if (selectedIds.size >= selectable.length && selectable.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectable.map((i) => i.id)));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 shadow-sm">
        <div className="relative flex-1">
          <MagnifyingGlass
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]"
            size={18}
          />
          <Input
            type="search"
            placeholder="Поиск по ФИО, email или компании…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-10 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as 'oldest' | 'newest')}
            className="h-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
            aria-label="Сортировка заявок"
          >
            <option value="oldest">Сначала старые</option>
            <option value="newest">Сначала новые</option>
          </select>
          {visibleItems.some((i) => !resolvedIds.has(i.id)) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-10"
              onClick={toggleSelectAll}
            >
              {selectedIds.size > 0 && selectedIds.size >= visibleItems.filter((i) => !resolvedIds.has(i.id)).length
                ? 'Снять выбор'
                : 'Выбрать все'}
            </Button>
          ) : null}
          {selectedIds.size > 0 ? (
            <Button
              type="button"
              size="sm"
              className="h-10"
              disabled={bulkBusy}
              onClick={approveSelected}
            >
              {bulkBusy ? 'Подтверждаем…' : `Подтвердить выбранные (${selectedIds.size})`}
            </Button>
          ) : null}
        </div>
      </div>

      {visibleItems.map((item) => {
        const busy = busyIds.has(item.id);
        const resolved = resolvedIds.has(item.id);
        const actionDisabled = busy || resolved;
        const label = fullName(item);
        const minimalZh = isMinimalZhApplication(item);
        const requestingRejection = rejectionId === item.id;
        const isSelected = selectedIds.has(item.id);
        return (
          <article
            key={item.id}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm transition-all hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)]"
          >
            <div className="grid gap-4 sm:grid-cols-[auto_4rem_minmax(0,1fr)] sm:gap-5 items-start">
              {!resolved ? (
                <div className="pt-2 sm:pt-4">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 rounded border-[var(--color-border-strong)] accent-[var(--color-primary)] cursor-pointer"
                    checked={isSelected}
                    disabled={actionDisabled}
                    onChange={(e) => {
                      setSelectedIds((curr) => {
                        const next = new Set(curr);
                        if (e.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      });
                    }}
                    aria-label={`Выбрать заявку: ${label}`}
                  />
                </div>
              ) : null}

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
                    <div className="flex flex-wrap gap-1.5 pb-1">
                      {QUICK_REASONS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() =>
                            setReasons((current) => ({ ...current, [item.id]: preset }))
                          }
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
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
            <p className="text-xs text-[var(--color-text-subtle)]">
              Код обращения: <code className="font-mono">{operationDiagnostic}</code> — назовите его в поддержке
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
