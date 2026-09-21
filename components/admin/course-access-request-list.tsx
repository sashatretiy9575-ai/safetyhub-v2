'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/ssr/ArrowsClockwise';
import { Button } from '@/components/ui/button';
import { requestAdminNotificationRefresh } from '@/components/admin/admin-notification-inbox';
import { clientRequest } from '@/lib/client-request';

export type RepeatRequestItem = {
  userId: string;
  courseId: string;
  courseTitle: string;
  requestedAt: string;
  name: string;
  surname: string;
  organization: string;
};

const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Oral',
});

/**
 * «Повторные заявки»: people who already train with us and asked for one more
 * course. One press opens it; the other answers without opening.
 */
export function CourseAccessRequestList({ items }: { items: readonly RepeatRequestItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState('');

  const act = async (item: RepeatRequestItem, open: boolean) => {
    const key = `${item.userId}:${item.courseId}`;
    if (busy) return;
    setBusy(key);
    setMessage('');
    const result = open
      ? await clientRequest(`/api/admin/users/${item.userId}/course-access`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant: [item.courseId], revoke: [] }),
        })
      : await clientRequest('/api/admin/course-access-requests', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: item.userId, courseId: item.courseId }),
        });
    setBusy(null);
    if (!result.ok) {
      setMessage('Не сохранилось. Повторите.');
      return;
    }
    setDone((current) => new Set(current).add(key));
    setMessage(
      open
        ? `Курс «${item.courseTitle}» открыт: ${person(item)}.`
        : `Запрос закрыт без доступа: ${person(item)}.`,
    );
    requestAdminNotificationRefresh();
    router.refresh();
  };

  const visible = items.filter((item) => !done.has(`${item.userId}:${item.courseId}`));
  if (!visible.length && !message) return null;

  return (
    <section className="space-y-3" aria-labelledby="repeat-requests-heading">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 id="repeat-requests-heading" className="font-display text-lg font-bold">
          Повторные заявки
        </h2>
        {visible.length ? (
          <span className="rounded-full bg-[var(--color-primary-soft)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-on-primary-soft)]">
            {visible.length}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Клиент уже обучается у нас и просит открыть ещё один курс.
      </p>
      {message ? (
        <p role="status" className="text-sm font-semibold">
          {message}
        </p>
      ) : null}
      <ul className="space-y-2">
        {visible.map((item) => {
          const key = `${item.userId}:${item.courseId}`;
          return (
            <li
              key={key}
              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-group)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm sm:px-4"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <ArrowsClockwise size={22} weight="bold" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-display block font-bold break-words">{person(item)}</span>
                <span className="block text-sm break-words text-[var(--color-text-muted)]">
                  {item.organization || 'Компания не указана'}
                </span>
                <span className="block text-sm font-semibold break-words text-[var(--color-primary)]">
                  Просит курс: {item.courseTitle}
                </span>
                <span className="block text-xs text-[var(--color-text-subtle)]">
                  {DATE_TIME.format(new Date(item.requestedAt))}
                </span>
              </span>
              <span className="flex w-full gap-2 sm:w-auto">
                <Button
                  type="button"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  disabled={busy !== null}
                  aria-busy={busy === key}
                  onClick={() => act(item, true)}
                >
                  Открыть курс
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="flex-1 sm:flex-none"
                  disabled={busy !== null}
                  onClick={() => act(item, false)}
                >
                  Не открывать
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function person(item: RepeatRequestItem) {
  return `${item.surname} ${item.name}`.trim() || 'Клиент без имени';
}
