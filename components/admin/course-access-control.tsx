'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as z from 'zod/mini';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

type CourseAccessItem = { id: string; title: string; slug: string; granted: boolean };

const coursesSchema = z.object({
  courses: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      slug: z.string(),
      granted: z.boolean(),
    }),
  ),
});
const savedSchema = z.object({ userId: z.uuid(), courseIds: z.array(z.uuid()) });

const errorMessages: Record<string, string> = {
  COURSE_ACCESS_COURSE_UNKNOWN: 'Один из курсов больше не существует. Обновите страницу.',
  ACCOUNT_UNAVAILABLE: 'Учётная запись недоступна: доступ изменить нельзя.',
  RATE_LIMITED: 'Слишком много изменений подряд. Подождите немного.',
};

const SAVE_FAILED = 'Доступ не сохранился. Попробуйте ещё раз.';
/** A tick is saved after this pause, so three quick ticks become one request. */
const SAVE_DELAY_MS = 600;
const SAVED_NOTICE_MS = 1_800;

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

async function putCourseAccess(
  userId: string,
  courseIds: ReadonlySet<string>,
): Promise<{ ok: true; courseIds: ReadonlySet<string> } | { ok: false; message: string }> {
  try {
    const result = await clientRequest(`/api/admin/users/${userId}/course-access`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseIds: [...courseIds] }),
    });
    const payload = await readClientResponseJson<unknown>(result.response);
    if (!result.ok) {
      const code =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error ?? '')
          : '';
      return {
        ok: false,
        message: errorMessages[code] ?? clientRequestMessage(result.error, SAVE_FAILED),
      };
    }
    const saved = savedSchema.safeParse(payload);
    if (!saved.success || saved.data.userId !== userId) {
      return { ok: false, message: 'Ответ сервера не подтверждён. Обновите страницу.' };
    }
    return { ok: true, courseIds: new Set(saved.data.courseIds) };
  } catch (error) {
    return { ok: false, message: clientRequestMessage(error, SAVE_FAILED) };
  }
}

/**
 * Which courses this learner may open: one checkbox per course, and a tick is
 * saved on its own a moment later. The list used to end in a separate "Save
 * access" button that sat under the phone's navigation dock.
 */
export function CourseAccessControl({ userId, canManage }: { userId: string; canManage: boolean }) {
  const headingId = useId();
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [courses, setCourses] = useState<CourseAccessItem[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // What the server last confirmed and what the boxes show now. They live in
  // refs as well, so a save that finishes late compares against the latest
  // ticks instead of the render it started from.
  const confirmedRef = useRef<ReadonlySet<string>>(new Set());
  const wantedRef = useRef<ReadonlySet<string>>(new Set());
  const savingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setError('');
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
      const granted = new Set(
        payload.data.courses.filter((course) => course.granted).map((course) => course.id),
      );
      confirmedRef.current = granted;
      wantedRef.current = granted;
      setCourses(payload.data.courses);
      setOpen(granted);
      setState('ready');
    })().catch(() => {
      if (!controller.signal.aborted) setState('failed');
    });
    return () => controller.abort();
  }, [attempt, userId]);

  const flush = useCallback(async () => {
    timerRef.current = null;
    if (savingRef.current) return;
    savingRef.current = true;
    let wrote = false;
    try {
      while (!sameSet(wantedRef.current, confirmedRef.current)) {
        setSaveState('saving');
        const outcome = await putCourseAccess(userId, wantedRef.current);
        if (!outcome.ok) {
          // The boxes return to what is really saved, so the card never shows
          // a course as open when the learner cannot open it.
          wantedRef.current = confirmedRef.current;
          setOpen(confirmedRef.current);
          setSaveState('idle');
          setError(outcome.message);
          return;
        }
        confirmedRef.current = outcome.courseIds;
        wrote = true;
      }
    } finally {
      savingRef.current = false;
    }
    if (!wrote) return;
    setSaveState('saved');
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setSaveState('idle');
    }, SAVED_NOTICE_MS);
  }, [userId]);

  // Closing the card right after a tick still saves that tick.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        void flush();
      }
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    [flush],
  );

  const toggle = (courseId: string) => {
    const next = new Set(wantedRef.current);
    if (next.has(courseId)) next.delete(courseId);
    else next.add(courseId);
    wantedRef.current = next;
    setOpen(next);
    setError('');
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-bold">
          Доступ к курсам
          {state === 'ready' ? (
            <span className="ml-1.5 font-semibold text-[var(--color-text-muted)] tabular-nums">
              {open.size}/{courses.length}
            </span>
          ) : null}
        </h3>
        <span role="status" className="text-xs text-[var(--color-text-muted)]">
          {saveState === 'saving' ? 'Сохраняем…' : saveState === 'saved' ? 'Сохранено' : ''}
        </span>
      </div>

      {state === 'loading' ? (
        <div className="grid gap-1 sm:grid-cols-2" aria-hidden="true">
          <span className="h-11 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
          <span className="h-11 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
          <span className="h-11 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
        </div>
      ) : state === 'failed' ? (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-danger)]"
        >
          Курсы не загрузились.
          <button
            type="button"
            className="min-h-11 font-semibold underline underline-offset-4"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </p>
      ) : courses.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Опубликованных курсов нет.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {courses.map((course) => {
            const checked = open.has(course.id);
            return (
              <li key={course.id}>
                {/* The whole line is the tap target, and an open course keeps a
                    tinted background so the ticked ones are seen at a glance. */}
                <label
                  className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                    canManage ? 'cursor-pointer' : 'cursor-default'
                  } ${
                    checked
                      ? 'bg-[var(--color-primary-soft)] font-semibold text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[var(--color-primary)]"
                    checked={checked}
                    disabled={!canManage}
                    onChange={() => toggle(course.id)}
                  />
                  <span className="min-w-0 flex-1 break-words">{course.title}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
