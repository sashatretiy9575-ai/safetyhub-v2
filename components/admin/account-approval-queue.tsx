'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Check } from '@phosphor-icons/react/dist/ssr/Check';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr/MagnifyingGlass';
import { UserCircle } from '@phosphor-icons/react/dist/ssr/UserCircle';
import { WhatsappLogo } from '@phosphor-icons/react/dist/ssr/WhatsappLogo';
import { X } from '@phosphor-icons/react/dist/ssr/X';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { requestAdminNotificationRefresh } from '@/components/admin/admin-notification-inbox';
import type { AdminAccountApprovalItem } from '@/features/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { formatPhoneDisplay } from '@/lib/site-contacts-shared';

type Decision = 'approved' | 'rejected';

/** A course the administrator may open: the published catalogue. */
export type ApprovalCourseOption = { id: string; title: string; slug: string };

const QUICK_REASONS = [
  'Фото нечёткое или не соответствует требованиям',
  'Уточните верное название компании',
  'Сотрудник отсутствует в списках компании',
];

const decisionResponseSchema = z
  .object({
    userId: z.string().uuid(),
    approvalState: z.enum(['approved', 'rejected']),
    decidedAt: z.string().datetime({ offset: true }),
    grantedCourseIds: z.array(z.string().uuid()).optional(),
    replayed: z.boolean(),
  })
  .strict();
const errorResponseSchema = z.object({ error: z.string().min(1).optional() }).strict();

const errorMessages: Record<string, string> = {
  ACCOUNT_APPROVAL_NOT_PENDING: 'Заявка уже была рассмотрена. Очередь обновлена.',
  ACCOUNT_APPROVAL_SELF_DECISION_FORBIDDEN:
    'Администратор не может подтверждать собственную заявку.',
  ACCOUNT_APPROVAL_DECISION_INVALID: 'Отметьте хотя бы один курс, который откроется сотруднику.',
  COURSE_ACCESS_COURSE_UNKNOWN: 'Один из курсов больше не существует. Обновите страницу.',
  IDEMPOTENCY_KEY_REUSED: 'Эта операция уже была отправлена с другими данными. Очередь обновлена.',
  RATE_LIMITED: 'Слишком много действий подряд. Подождите немного и повторите.',
};

const unconfirmedResultMessage = 'Ответ сервера не подтверждён. Проверьте заявку перед повтором.';

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

function whatsappHref(phoneE164: string) {
  return `https://wa.me/${phoneE164.replace(/\D/g, '')}`;
}

function courseWord(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'курс';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'курса';
  return 'курсов';
}

/** Long enough to coalesce a burst of decisions into one server round trip. */
const QUEUE_REFRESH_DEBOUNCE_MS = 1_500;

function Avatar({
  item,
  size,
  className = '',
}: {
  item: AdminAccountApprovalItem;
  size: 48 | 112;
  className?: string;
}) {
  const label = fullName(item);
  const box = size === 48 ? 'size-12 rounded-xl text-lg' : 'size-28 rounded-2xl text-4xl';
  return item.avatarAvailable ? (
    // One request per row, all at once, against an admin-only endpoint — and
    // with no dimensions the list reflowed as each one landed.
    <img
      src={`/api/admin/attestations/avatar/${item.id}`}
      alt={`Фото профиля: ${label}`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`${box} shrink-0 border border-[var(--color-border)] object-cover ${className}`}
    />
  ) : (
    <div
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-black text-[var(--color-primary)] ${className}`}
    >
      {label.charAt(0).toUpperCase()}
    </div>
  );
}

/** A course chip: pressed means the course opens with the approval. */
function CourseChip({
  course,
  pressed,
  disabled,
  onToggle,
}: {
  course: ApprovalCourseOption;
  pressed: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onToggle(!pressed)}
      className={`inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1 text-left text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
        pressed
          ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid size-4 shrink-0 place-items-center rounded border ${
          pressed
            ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
            : 'border-[var(--color-border-strong)]'
        }`}
      >
        {pressed ? <Check size={11} weight="bold" /> : null}
      </span>
      <span className="min-w-0 break-words">{course.title}</span>
    </button>
  );
}

/**
 * The full application, opened by clicking the person: photo, every field
 * they submitted, and the two ways to reach them.
 */
function ApplicantProfileDialog({
  item,
  onClose,
}: {
  item: AdminAccountApprovalItem | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (item && dialog && !dialog.open) dialog.showModal();
    if (!item && dialog?.open) dialog.close();
  }, [item]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (item) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(28rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/55"
    >
      {item ? (
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <Avatar item={item} size={112} />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Закрыть"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <h2 className="mt-4 text-xl font-bold break-words">{fullName(item)}</h2>
          <p className="mt-0.5 text-sm break-all text-[var(--color-text-muted)]">
            {accountIdentifier(item)}
          </p>

          <dl className="mt-5 grid gap-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--color-text-subtle)]">Должность</dt>
              <dd className="mt-0.5 break-words">{item.job || 'Не указана'}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-text-subtle)]">Компания</dt>
              <dd className="mt-0.5 break-words">{item.organization || 'Не указана'}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-text-subtle)]">Телефон</dt>
              <dd className="mt-0.5">
                {item.phoneE164 ? (
                  <a
                    className="font-semibold tabular-nums underline underline-offset-4"
                    href={`tel:${item.phoneE164}`}
                  >
                    {formatPhoneDisplay(item.phoneE164)}
                  </a>
                ) : (
                  'Не указан'
                )}
              </dd>
            </div>
            {item.email ? (
              <div>
                <dt className="text-xs text-[var(--color-text-subtle)]">Почта</dt>
                <dd className="mt-0.5 break-all">
                  <a className="underline underline-offset-4" href={`mailto:${item.email}`}>
                    {item.email}
                  </a>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs text-[var(--color-text-subtle)]">Заявка</dt>
              <dd className="mt-0.5 text-[var(--color-text-muted)]">
                Отправлена <time dateTime={item.requestedAt}>{dateTime(item.requestedAt)}</time>
                <br />
                Ответить до <time dateTime={item.dueAt}>{dateTime(item.dueAt)}</time>
              </dd>
            </div>
          </dl>

          {item.phoneE164 ? (
            <Button asChild className="mt-5 w-full">
              <a href={whatsappHref(item.phoneE164)} target="_blank" rel="noopener noreferrer">
                <WhatsappLogo size={18} aria-hidden="true" />
                Написать в WhatsApp
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function AccountApprovalQueue({
  items,
  courses,
}: {
  items: AdminAccountApprovalItem[];
  courses: ApprovalCourseOption[];
}) {
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
  // Which courses each application opens. Nothing is pre-ticked: the owner's
  // rule is that access is granted by hand, course by course.
  const [courseSelections, setCourseSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const [profileId, setProfileId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const operationKeys = useRef(new Map<string, string>());
  const busyIdsRef = useRef(new Set<string>());
  const resolvedIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // B4-14: the pending refresh survived unmount and called `router.refresh()`
  // on a page the operator had already left.
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    },
    [],
  );

  const refreshQueueNow = () => {
    requestAdminNotificationRefresh();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    router.refresh();
  };

  const refreshQueueSoon = () => {
    requestAdminNotificationRefresh();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      router.refresh();
    }, QUEUE_REFRESH_DEBOUNCE_MS);
  };

  const reportUnconfirmedResult = (idempotencyKey: string) => {
    setMessage(unconfirmedResultMessage);
    setOperationDiagnostic(idempotencyKey);
    refreshQueueNow();
  };

  const coursesFor = (itemId: string) => courseSelections[itemId] ?? new Set<string>();

  const setCourse = (itemIds: readonly string[], courseId: string, checked: boolean) => {
    setMessage('');
    setOperationDiagnostic('');
    setCourseSelections((current) => {
      const next = { ...current };
      for (const itemId of itemIds) {
        const selection = new Set(current[itemId] ?? []);
        if (checked) selection.add(courseId);
        else selection.delete(courseId);
        next[itemId] = selection;
      }
      return next;
    });
  };

  const setAllCourses = (itemIds: readonly string[], checked: boolean) => {
    setMessage('');
    setOperationDiagnostic('');
    setCourseSelections((current) => {
      const next = { ...current };
      for (const itemId of itemIds) {
        next[itemId] = new Set(checked ? courses.map((course) => course.id) : []);
      }
      return next;
    });
  };

  const decide = async (item: AdminAccountApprovalItem, decision: Decision) => {
    const reason = (reasons[item.id] ?? '').trim();
    const courseIds = [...coursesFor(item.id)].sort();
    if (decision === 'rejected' && reason.length < 3) {
      setMessage('Для отказа укажите понятный комментарий не короче трёх символов.');
      setOperationDiagnostic('');
      return false;
    }
    if (decision === 'approved' && courseIds.length === 0) {
      setMessage(`Отметьте хотя бы один курс для: ${fullName(item)}.`);
      setOperationDiagnostic('');
      return false;
    }
    if (busyIdsRef.current.has(item.id) || resolvedIdsRef.current.has(item.id)) return false;

    const operationKey = `${item.id}:${decision}:${reason}:${courseIds.join(',')}`;
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
          ...(decision === 'rejected' ? { reason } : { courseIds }),
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
        refreshQueueSoon();
        return false;
      }

      const receipt = decisionResponseSchema.safeParse(payload);
      if (
        !receipt.success ||
        receipt.data.userId !== item.id ||
        receipt.data.approvalState !== decision
      ) {
        reportUnconfirmedResult(idempotencyKey);
        return false;
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
          ? `Доступ подтверждён: ${fullName(item)}, ${courseIds.length} ${courseWord(courseIds.length)}.`
          : 'Заявка возвращена на уточнение.',
      );
      refreshQueueSoon();
      return true;
    } catch (error) {
      setMessage(clientRequestMessage(error, 'Не удалось сохранить решение. Попробуйте ещё раз.'));
      setOperationDiagnostic(idempotencyKey);
      refreshQueueSoon();
      return false;
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

  const selectableItems = visibleItems.filter((item) => !resolvedIds.has(item.id));
  const selectedItems = selectableItems.filter((item) => selectedIds.has(item.id));
  const selectedItemIds = selectedItems.map((item) => item.id);
  const selectedWithoutCourses = selectedItems.filter((item) => coursesFor(item.id).size === 0);

  const approveSelected = async () => {
    if (selectedItems.length === 0 || bulkBusy) return;
    if (selectedWithoutCourses.length > 0) {
      setMessage(
        `Сначала отметьте курсы для всех выбранных заявок (без курсов: ${selectedWithoutCourses.length}).`,
      );
      setOperationDiagnostic('');
      return;
    }
    setBulkBusy(true);
    let approved = 0;
    for (const item of selectedItems) {
      if (busyIdsRef.current.has(item.id) || resolvedIdsRef.current.has(item.id)) continue;
      if (await decide(item, 'approved')) approved += 1;
    }
    setSelectedIds(new Set());
    setBulkBusy(false);
    if (approved > 1) setMessage(`Подтверждено заявок: ${approved}.`);
  };

  const toggleSelectAll = () => {
    if (selectedItems.length >= selectableItems.length && selectableItems.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableItems.map((item) => item.id)));
    }
  };

  const profileItem = profileId ? (items.find((item) => item.id === profileId) ?? null) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <MagnifyingGlass
            className="absolute top-1/2 left-3.5 -translate-y-1/2 text-[var(--color-text-subtle)]"
            size={18}
          />
          <Input
            type="search"
            placeholder="Поиск по ФИО, email или компании…"
            aria-label="Поиск по ФИО, email или компании"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-10 pl-10 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value as 'oldest' | 'newest')}
            className="h-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-semibold text-[var(--color-text)] focus:border-[var(--color-primary)]"
            aria-label="Сортировка заявок"
          >
            <option value="oldest">Сначала старые</option>
            <option value="newest">Сначала новые</option>
          </select>
          {selectableItems.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-10"
              onClick={toggleSelectAll}
            >
              {selectedItems.length > 0 && selectedItems.length >= selectableItems.length
                ? 'Снять выбор'
                : 'Выбрать все'}
            </Button>
          ) : null}
        </div>
      </div>

      {selectedItems.length > 0 ? (
        // One place to tick courses for several applications at once; the
        // per-card chips below reflect the same selection.
        <section
          aria-label="Курсы для выбранных заявок"
          className="space-y-3 rounded-2xl border border-[var(--color-primary)]/40 bg-[var(--color-primary-soft)]/40 p-3 sm:p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-bold">
              Выбрано заявок: {selectedItems.length}. Какие курсы открыть?
            </p>
            <div className="flex gap-3 text-xs font-semibold">
              <button
                type="button"
                className="text-[var(--color-primary)] hover:underline"
                onClick={() => setAllCourses(selectedItemIds, true)}
              >
                Все курсы
              </button>
              <button
                type="button"
                className="text-[var(--color-text-muted)] hover:underline"
                onClick={() => setAllCourses(selectedItemIds, false)}
              >
                Снять
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {courses.map((course) => {
              const pressedCount = selectedItems.filter((item) =>
                coursesFor(item.id).has(course.id),
              ).length;
              return (
                <CourseChip
                  key={course.id}
                  course={course}
                  pressed={pressedCount === selectedItems.length}
                  disabled={bulkBusy}
                  onToggle={(next) => setCourse(selectedItemIds, course.id, next)}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              disabled={bulkBusy || selectedWithoutCourses.length > 0}
              onClick={() => void approveSelected()}
            >
              {bulkBusy ? 'Подтверждаем…' : `Подтвердить выбранные (${selectedItems.length})`}
            </Button>
            {selectedWithoutCourses.length > 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                Без курсов: {selectedWithoutCourses.length}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {courses.length === 0 ? (
        <p
          role="alert"
          className="rounded-2xl border border-[var(--color-warning)]/50 bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text-muted)]"
        >
          Опубликованных курсов нет, поэтому подтвердить заявку пока нельзя: подтверждение открывает
          конкретные курсы.
        </p>
      ) : null}

      {visibleItems.map((item) => {
        const busy = busyIds.has(item.id);
        const resolved = resolvedIds.has(item.id);
        const actionDisabled = busy || resolved;
        const label = fullName(item);
        const requestingRejection = rejectionId === item.id;
        const isSelected = selectedIds.has(item.id);
        const selection = coursesFor(item.id);
        const subtitle = [item.job, item.organization].filter(Boolean).join(' · ');
        return (
          <article
            key={item.id}
            className={`rounded-2xl border bg-[var(--color-surface)] p-4 shadow-sm transition-colors sm:p-5 ${
              isSelected ? 'border-[var(--color-primary)]/60' : 'border-[var(--color-border)]'
            }`}
          >
            <div className="flex items-start gap-3">
              {!resolved ? (
                <label className="grid size-11 shrink-0 -translate-x-2 cursor-pointer place-items-center">
                  <input
                    type="checkbox"
                    className="size-4.5 accent-[var(--color-primary)]"
                    checked={isSelected}
                    disabled={actionDisabled}
                    onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      });
                    }}
                  />
                  <span className="sr-only">Выбрать заявку: {label}</span>
                </label>
              ) : null}

              <button
                type="button"
                onClick={() => setProfileId(item.id)}
                className="shrink-0 rounded-xl transition hover:opacity-85 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:outline-none"
                aria-label={`Открыть профиль: ${label}`}
              >
                <Avatar item={item} size={48} />
              </button>

              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setProfileId(item.id)}
                  className="font-display block max-w-full text-left text-base font-bold break-words hover:underline"
                >
                  {label}
                </button>
                <p className="mt-0.5 text-sm break-words text-[var(--color-text-muted)]">
                  {subtitle || 'Должность и компания не указаны'}
                </p>
                <p className="mt-0.5 text-xs break-all text-[var(--color-text-subtle)]">
                  {item.phoneE164 ? `${formatPhoneDisplay(item.phoneE164)} · ` : ''}
                  {accountIdentifier(item)} · до {dateTime(item.dueAt)}
                </p>
              </div>

              <div className="flex shrink-0 gap-1">
                {item.phoneE164 ? (
                  <Button asChild size="icon" variant="outline" className="size-11">
                    <a
                      href={whatsappHref(item.phoneE164)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Написать в WhatsApp: ${label}`}
                      title="Написать в WhatsApp"
                    >
                      <WhatsappLogo size={20} aria-hidden="true" />
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-11"
                  aria-label={`Открыть профиль: ${label}`}
                  title="Профиль"
                  onClick={() => setProfileId(item.id)}
                >
                  <UserCircle size={22} aria-hidden="true" />
                </Button>
              </div>
            </div>

            {!resolved ? (
              <div className="mt-4 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-semibold text-[var(--color-text-muted)]">
                    Открыть курсы
                    {selection.size > 0 ? (
                      <span className="ml-1 text-[var(--color-primary)]">· {selection.size}</span>
                    ) : null}
                  </p>
                  {courses.length > 1 ? (
                    <button
                      type="button"
                      className="text-xs font-semibold text-[var(--color-primary)] hover:underline"
                      disabled={actionDisabled}
                      onClick={() => setAllCourses([item.id], selection.size < courses.length)}
                    >
                      {selection.size < courses.length ? 'Все курсы' : 'Снять все'}
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {courses.map((course) => (
                    <CourseChip
                      key={course.id}
                      course={course}
                      pressed={selection.has(course.id)}
                      disabled={actionDisabled}
                      onToggle={(next) => setCourse([item.id], course.id, next)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {requestingRejection ? (
              <div className="mt-4 space-y-2 border-t border-[var(--color-border)] pt-3">
                {/* The label used to wrap the whole block, so the quick-reason
                    buttons were inside it: their text joined the field's
                    accessible name, and clicking one also focused the
                    textarea. */}
                <div className="block space-y-1">
                  <label
                    htmlFor={`approval-reason-${item.id}`}
                    className="block text-xs font-semibold text-[var(--color-text-muted)]"
                  >
                    Что нужно уточнить
                  </label>
                  <div className="flex flex-wrap gap-1.5 pb-1">
                    {QUICK_REASONS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setReasons((current) => ({ ...current, [item.id]: preset }))}
                        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                  <Textarea
                    id={`approval-reason-${item.id}`}
                    value={reasons[item.id] ?? ''}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                    }
                    maxLength={500}
                    rows={2}
                    placeholder="Например: уточните название компании."
                    disabled={actionDisabled}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
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
                    className="min-h-11"
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
                className="mt-4 border-t border-[var(--color-border)] pt-3 text-sm text-[var(--color-text-muted)]"
              >
                Решение сохранено. Обновляем очередь…
              </p>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11"
                  disabled={actionDisabled || selection.size === 0}
                  onClick={() => void decide(item, 'approved')}
                >
                  {busy
                    ? 'Подтверждаем…'
                    : selection.size === 0
                      ? 'Подтвердить доступ'
                      : `Подтвердить: ${selection.size} ${courseWord(selection.size)}`}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11"
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
              Код обращения: <code className="font-mono">{operationDiagnostic}</code> — назовите его
              в поддержке
            </p>
          ) : null}
        </div>
      ) : null}

      <ApplicantProfileDialog item={profileItem} onClose={() => setProfileId(null)} />
    </div>
  );
}
