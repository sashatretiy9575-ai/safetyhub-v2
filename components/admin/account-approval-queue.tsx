'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as z from 'zod/mini';
import { Check } from '@phosphor-icons/react/dist/ssr/Check';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr/MagnifyingGlass';
import { WhatsappLogo } from '@phosphor-icons/react/dist/ssr/WhatsappLogo';
import { X } from '@phosphor-icons/react/dist/ssr/X';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { requestAdminNotificationRefresh } from '@/components/admin/admin-notification-inbox';
import type { AdminAccountApprovalItem } from '@/lib/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { formatPhoneDisplay, phoneHref, whatsappChatHref } from '@/lib/site-contacts';
import { NewTabHint } from '@/components/shared/new-tab-hint';

type Decision = 'approved' | 'rejected';

/** A course the administrator may open: the published catalogue. */
export type ApprovalCourseOption = { id: string; title: string; slug: string };

const QUICK_REASONS = [
  'Фото нечёткое или не соответствует требованиям',
  'Уточните верное название компании',
  'Сотрудник отсутствует в списках компании',
];

const decisionResponseSchema = z.strictObject({
  userId: z.uuid(),
  approvalState: z.enum(['approved', 'rejected']),
  decidedAt: z.iso.datetime({ offset: true }),
  grantedCourseIds: z.optional(z.array(z.uuid())),
  replayed: z.boolean(),
});
const errorResponseSchema = z.strictObject({ error: z.optional(z.string().check(z.minLength(1))) });

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

/**
 * The first message to an applicant, ready to send: who is writing, where
 * the application came from, what happens next. The administrator only has
 * to press "send" — or edit it first.
 */
export function whatsappGreeting(item: AdminAccountApprovalItem) {
  const name = item.name.trim();
  return [
    `Здравствуйте${name ? `, ${name}` : ''}!`,
    'Это администратор SafetyHub. Вы оставляли заявку на обучение на сайте safetyhub.kz.',
    'Подскажите, пожалуйста, какие курсы вам нужны — после этого мы откроем к ним доступ.',
  ].join(' ');
}

export function whatsappHref(item: AdminAccountApprovalItem) {
  if (!item.phoneE164) return null;
  return whatsappChatHref(item.phoneE164, whatsappGreeting(item));
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

function Avatar({ item, size }: { item: AdminAccountApprovalItem; size: 48 | 96 }) {
  const label = fullName(item);
  const box =
    size === 48 ? 'size-12 rounded-xl text-lg' : 'size-24 rounded-[var(--radius-group)] text-3xl';
  return item.avatarUrl ? (
    // The signed URL arrives with the page, so the list makes no extra requests
    // — and with fixed dimensions it no longer reflows as photos land.
    <img
      src={item.avatarUrl}
      alt={`Фото профиля: ${label}`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`${box} shrink-0 border border-[var(--color-border)] object-cover`}
    />
  ) : (
    <div
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-black text-[var(--color-primary)]`}
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
      className={`inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border px-3 py-1.5 text-left text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
        pressed
          ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid size-5 shrink-0 place-items-center rounded-md border ${
          pressed
            ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
            : 'border-[var(--color-border-strong)]'
        }`}
      >
        {pressed ? <Check size={12} weight="bold" /> : null}
      </span>
      <span className="min-w-0 break-words">{course.title}</span>
    </button>
  );
}

function CoursePicker({
  courses,
  selection,
  disabled,
  onToggle,
  onAll,
}: {
  courses: ApprovalCourseOption[];
  selection: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (courseId: string, next: boolean) => void;
  onAll: (checked: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold">
          Открыть курсы
          {selection.size > 0 ? (
            <span className="ml-1.5 text-[var(--color-primary)]">· {selection.size}</span>
          ) : null}
        </p>
        {courses.length > 1 ? (
          <button
            type="button"
            className="text-xs font-semibold text-[var(--color-primary)] hover:underline"
            disabled={disabled}
            onClick={() => onAll(selection.size < courses.length)}
          >
            {selection.size < courses.length ? 'Все курсы' : 'Снять все'}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {courses.map((course) => (
          <CourseChip
            key={course.id}
            course={course}
            pressed={selection.has(course.id)}
            disabled={disabled}
            onToggle={(next) => onToggle(course.id, next)}
          />
        ))}
      </div>
    </div>
  );
}

export function AccountApprovalQueue({
  items,
  courses,
  requestedCourses = {},
}: {
  items: AdminAccountApprovalItem[];
  courses: ApprovalCourseOption[];
  /** The courses each newcomer clicked before applying, by person. */
  requestedCourses?: Readonly<Record<string, readonly string[]>>;
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
  // Which courses each application opens. The course the person clicked
  // before applying is ticked by default; everything else is ticked by hand.
  const [courseSelections, setCourseSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const operationKeys = useRef(new Map<string, string>());
  const busyIdsRef = useRef(new Set<string>());
  const resolvedIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // B4-14: the pending refresh survived unmount and called `router.refresh()`
  // on a page the operator had already left.
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    },
    [],
  );

  const openItem = openId ? (items.find((item) => item.id === openId) ?? null) : null;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (openItem && dialog && !dialog.open) dialog.showModal();
    if (!openItem && dialog?.open) dialog.close();
  }, [openItem]);

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

  const requestedFor = (itemId: string): readonly string[] =>
    (requestedCourses[itemId] ?? []).filter((courseId) =>
      courses.some((course) => course.id === courseId),
    );
  const requestedTitles = (itemId: string) =>
    requestedFor(itemId)
      .map((courseId) => courses.find((course) => course.id === courseId)?.title)
      .filter(Boolean)
      .join(', ');
  const coursesFor = (itemId: string): ReadonlySet<string> =>
    courseSelections[itemId] ?? new Set(requestedFor(itemId));

  const setCourse = (itemIds: readonly string[], courseId: string, checked: boolean) => {
    setMessage('');
    setOperationDiagnostic('');
    setCourseSelections((current) => {
      const next = { ...current };
      for (const itemId of itemIds) {
        const selection = new Set(current[itemId] ?? requestedFor(itemId));
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
      setOpenId((current) => (current === item.id ? null : current));
      setMessage(
        decision === 'approved'
          ? `Доступ подтверждён: ${fullName(item)}, ${courseIds.length} ${courseWord(courseIds.length)}.`
          : `Заявка возвращена на уточнение: ${fullName(item)}.`,
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

  const closeDialog = () => {
    setOpenId(null);
    setRejectionId(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-[var(--radius-group)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <MagnifyingGlass
            aria-hidden="true"
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
        // One place to tick courses for several applications at once.
        <section
          aria-label="Курсы для выбранных заявок"
          className="space-y-3 rounded-[var(--radius-group)] border border-[var(--color-primary)]/40 bg-[var(--color-primary-soft)]/40 p-3 sm:p-4"
        >
          <p className="text-sm font-bold">
            Выбрано заявок: {selectedItems.length}. Какие курсы открыть всем?
          </p>
          <CoursePicker
            courses={courses}
            selection={
              new Set(
                courses
                  .filter((course) =>
                    selectedItems.every((item) => coursesFor(item.id).has(course.id)),
                  )
                  .map((course) => course.id),
              )
            }
            disabled={bulkBusy}
            onToggle={(courseId, next) => setCourse(selectedItemIds, courseId, next)}
            onAll={(checked) => setAllCourses(selectedItemIds, checked)}
          />
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
          className="rounded-[var(--radius-group)] border border-[var(--color-warning)]/50 bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text-muted)]"
        >
          Опубликованных курсов нет, поэтому подтвердить заявку пока нельзя: подтверждение открывает
          конкретные курсы.
        </p>
      ) : null}

      <ul className="space-y-2">
        {visibleItems.map((item) => {
          const resolved = resolvedIds.has(item.id);
          const label = fullName(item);
          const isSelected = selectedIds.has(item.id);
          const selection = coursesFor(item.id);
          const subtitle = [item.job, item.organization].filter(Boolean).join(' · ');
          const whatsapp = whatsappHref(item);
          return (
            <li
              key={item.id}
              className={`flex items-center gap-3 rounded-[var(--radius-group)] border bg-[var(--color-surface)] p-3 shadow-sm transition-colors sm:px-4 ${
                isSelected ? 'border-[var(--color-primary)]/60' : 'border-[var(--color-border)]'
              } ${resolved ? 'opacity-60' : ''}`}
            >
              {!resolved ? (
                <label className="grid size-11 shrink-0 -translate-x-1 cursor-pointer place-items-center">
                  <input
                    type="checkbox"
                    className="size-4.5 accent-[var(--color-primary)]"
                    checked={isSelected}
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

              {/* The whole card opens the application: the person, the ways
                  to reach them and the courses to open live in one place. */}
              <button
                type="button"
                disabled={resolved}
                onClick={() => setOpenId(item.id)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left"
                aria-label={`Открыть заявку: ${label}`}
              >
                <Avatar item={item} size={48} />
                <span className="min-w-0 flex-1">
                  <span className="font-display block truncate text-base font-bold">{label}</span>
                  <span className="block truncate text-sm text-[var(--color-text-muted)]">
                    {subtitle || 'Должность и компания не указаны'}
                  </span>
                  {requestedTitles(item.id) ? (
                    <span className="block truncate text-sm font-semibold text-[var(--color-primary)]">
                      Выбрал курс: {requestedTitles(item.id)}
                    </span>
                  ) : null}
                  <span className="block truncate text-xs text-[var(--color-text-subtle)]">
                    {resolved
                      ? 'Решение сохранено. Обновляем очередь…'
                      : selection.size > 0
                        ? `Отмечено: ${selection.size} ${courseWord(selection.size)} · до ${dateTime(item.dueAt)}`
                        : `до ${dateTime(item.dueAt)}`}
                  </span>
                </span>
              </button>

              {whatsapp && !resolved ? (
                <Button asChild size="icon" variant="outline" className="size-11 shrink-0">
                  <a
                    href={whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Написать в WhatsApp: ${label} (откроется в новой вкладке)`}
                    title="Написать в WhatsApp"
                  >
                    <WhatsappLogo size={20} aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

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

      <dialog
        ref={dialogRef}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => {
          if (openItem) closeDialog();
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current) closeDialog();
        }}
        className="m-auto max-h-[calc(100dvh-1rem)] w-[min(32rem,calc(100vw-1rem))] overflow-y-auto rounded-[var(--radius-group)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/55"
      >
        {openItem
          ? (() => {
              const item = openItem;
              const label = fullName(item);
              const busy = busyIds.has(item.id);
              const selection = coursesFor(item.id);
              const whatsapp = whatsappHref(item);
              const requestingRejection = rejectionId === item.id;
              return (
                <div className="space-y-5 p-4 sm:p-5">
                  <div className="flex items-start gap-4">
                    <Avatar item={item} size={96} />
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg font-bold break-words">{label}</h2>
                      <p className="mt-0.5 text-sm break-words text-[var(--color-text-muted)]">
                        {[item.job, item.organization].filter(Boolean).join(' · ') ||
                          'Должность и компания не указаны'}
                      </p>
                      <p className="mt-0.5 text-xs break-all text-[var(--color-text-subtle)]">
                        {accountIdentifier(item)}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">
                        Заявка от {dateTime(item.requestedAt)} · ответить до {dateTime(item.dueAt)}
                      </p>
                      {requestedTitles(item.id) ? (
                        <p className="mt-1 text-sm font-semibold break-words text-[var(--color-primary)]">
                          Выбрал курс: {requestedTitles(item.id)} — отмечен ниже
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Закрыть"
                      onClick={closeDialog}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>

                  <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-[var(--color-text-subtle)]">Телефон</dt>
                      <dd className="mt-0.5">
                        {item.phoneE164 ? (
                          <a
                            className="font-semibold tabular-nums underline underline-offset-4"
                            href={phoneHref(item.phoneE164)}
                          >
                            {formatPhoneDisplay(item.phoneE164)}
                          </a>
                        ) : (
                          'Не указан'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--color-text-subtle)]">Почта</dt>
                      <dd className="mt-0.5 break-all">
                        {item.email ? (
                          <a className="underline underline-offset-4" href={`mailto:${item.email}`}>
                            {item.email}
                          </a>
                        ) : (
                          'Не указана'
                        )}
                      </dd>
                    </div>
                  </dl>

                  {whatsapp ? (
                    <Button asChild variant="outline" className="min-h-11 w-full">
                      <a href={whatsapp} target="_blank" rel="noopener noreferrer">
                        <WhatsappLogo size={18} aria-hidden="true" />
                        Написать в WhatsApp
                        <NewTabHint />
                      </a>
                    </Button>
                  ) : null}

                  <CoursePicker
                    courses={courses}
                    selection={selection}
                    disabled={busy}
                    onToggle={(courseId, next) => setCourse([item.id], courseId, next)}
                    onAll={(checked) => setAllCourses([item.id], checked)}
                  />

                  {requestingRejection ? (
                    <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
                      {/* The label used to wrap the whole block, so the quick-reason
                          buttons were inside it: their text joined the field's
                          accessible name, and clicking one also focused the
                          textarea. */}
                      <label
                        htmlFor={`approval-reason-${item.id}`}
                        className="block text-xs font-semibold text-[var(--color-text-muted)]"
                      >
                        Что нужно уточнить
                      </label>
                      <div className="flex flex-wrap gap-1.5">
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
                        id={`approval-reason-${item.id}`}
                        value={reasons[item.id] ?? ''}
                        onChange={(event) =>
                          setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                        maxLength={500}
                        rows={2}
                        placeholder="Например: уточните название компании."
                        disabled={busy}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="min-h-11"
                          disabled={busy}
                          onClick={() => setRejectionId(null)}
                        >
                          Отмена
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          disabled={busy || (reasons[item.id] ?? '').trim().length < 3}
                          onClick={() => void decide(item, 'rejected')}
                        >
                          {busy ? 'Сохраняем…' : 'Вернуть на уточнение'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
                      <Button
                        type="button"
                        className="min-h-11 flex-1"
                        disabled={busy || selection.size === 0}
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
                        variant="ghost"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => setRejectionId(item.id)}
                      >
                        Вернуть на уточнение
                      </Button>
                    </div>
                  )}
                </div>
              );
            })()
          : null}
      </dialog>
    </div>
  );
}
