'use client';

import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

type CourseAccessItem = { id: string; title: string; slug: string; granted: boolean };

const coursesSchema = z.object({
  courses: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      slug: z.string(),
      granted: z.boolean(),
    }),
  ),
});
const savedSchema = z.object({ userId: z.string().uuid(), courseIds: z.array(z.string().uuid()) });

const errorMessages: Record<string, string> = {
  COURSE_ACCESS_COURSE_UNKNOWN: 'Один из курсов больше не существует. Обновите страницу.',
  ACCOUNT_UNAVAILABLE: 'Учётная запись недоступна: доступ изменить нельзя.',
  RATE_LIMITED: 'Слишком много действий подряд. Подождите немного и повторите.',
};

/**
 * Which courses this learner may open. Approval alone opens nothing since
 * September 2026; the administrator ticks courses here (or in the approval
 * queue) and the set can be changed at any time — a new course, a finished
 * one, a mistake.
 */
export function CourseAccessControl({ userId, canManage }: { userId: string; canManage: boolean }) {
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [courses, setCourses] = useState<CourseAccessItem[]>([]);
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setMessage(null);
    void (async () => {
      const result = await clientRequest(
        `/api/admin/users/${userId}/course-access`,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const payload = coursesSchema.safeParse(
        await readClientResponseJson<unknown>(result.response),
      );
      if (!result.ok || !payload.success) {
        setState('failed');
        return;
      }
      setCourses(payload.data.courses);
      setDraft(new Set(payload.data.courses.filter((course) => course.granted).map((c) => c.id)));
      setState('ready');
    })().catch(() => {
      if (!controller.signal.aborted) setState('failed');
    });
    return () => controller.abort();
  }, [userId]);

  const granted = useMemo(
    () => new Set(courses.filter((course) => course.granted).map((course) => course.id)),
    [courses],
  );
  const dirty =
    draft.size !== granted.size || [...draft].some((courseId) => !granted.has(courseId));

  const toggle = (courseId: string, checked: boolean) => {
    setMessage(null);
    setDraft((current) => {
      const next = new Set(current);
      if (checked) next.add(courseId);
      else next.delete(courseId);
      return next;
    });
  };

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await clientRequest(`/api/admin/users/${userId}/course-access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseIds: [...draft] }),
      });
      const payload = await readClientResponseJson<unknown>(result.response);
      if (!result.ok) {
        const code =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error ?? '')
            : '';
        setMessage({
          text:
            errorMessages[code] ??
            clientRequestMessage(result.error, 'Не удалось сохранить доступ. Попробуйте ещё раз.'),
          tone: 'error',
        });
        return;
      }
      const saved = savedSchema.safeParse(payload);
      if (!saved.success || saved.data.userId !== userId) {
        setMessage({ text: 'Ответ сервера не подтверждён. Обновите страницу.', tone: 'error' });
        return;
      }
      const openIds = new Set(saved.data.courseIds);
      setCourses((current) =>
        current.map((course) => ({ ...course, granted: openIds.has(course.id) })),
      );
      setDraft(new Set(openIds));
      setMessage({
        text: openIds.size === 0 ? 'Все курсы закрыты.' : `Открыто курсов: ${openIds.size}.`,
        tone: 'ok',
      });
    } catch (error) {
      setMessage({
        text: clientRequestMessage(error, 'Не удалось сохранить доступ. Попробуйте ещё раз.'),
        tone: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-2xl border p-4"
      aria-labelledby={`course-access-${userId}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`course-access-${userId}`} className="text-base font-bold">
          Доступ к курсам
        </h3>
        {state === 'ready' ? (
          <p className="text-xs text-[var(--color-text-muted)] tabular-nums">
            Открыто {granted.size} из {courses.length}
          </p>
        ) : null}
      </div>

      {state === 'loading' ? (
        <p className="text-sm text-[var(--color-text-muted)]">Загружаем курсы…</p>
      ) : state === 'failed' ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          Список курсов временно недоступен.
        </p>
      ) : courses.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Опубликованных курсов пока нет.</p>
      ) : (
        <>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                onClick={() => {
                  setMessage(null);
                  setDraft(new Set(courses.map((course) => course.id)));
                }}
              >
                Открыть все
              </button>
              <button
                type="button"
                className="min-h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                onClick={() => {
                  setMessage(null);
                  setDraft(new Set());
                }}
              >
                Закрыть все
              </button>
            </div>
          ) : null}
          <ul className="space-y-1">
            {courses.map((course) => {
              const checked = draft.has(course.id);
              return (
                <li key={course.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 text-sm transition hover:bg-[var(--color-surface-muted)]">
                    <input
                      type="checkbox"
                      className="size-4.5 shrink-0 accent-[var(--color-primary)]"
                      checked={checked}
                      disabled={!canManage || saving}
                      onChange={(event) => toggle(course.id, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1 break-words">{course.title}</span>
                    {course.granted !== checked ? (
                      <span className="shrink-0 text-xs font-semibold text-[var(--color-primary)]">
                        {checked ? 'откроется' : 'закроется'}
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => void save()}
                className="min-h-11"
              >
                {saving ? 'Сохраняем…' : 'Сохранить доступ'}
              </Button>
              {dirty && !saving ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => {
                    setMessage(null);
                    setDraft(new Set(granted));
                  }}
                >
                  Отменить
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'text-xs text-[var(--color-danger)]'
              : 'text-xs text-[var(--color-text-muted)]'
          }
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
