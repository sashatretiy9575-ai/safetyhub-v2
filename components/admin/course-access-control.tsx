'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as z from 'zod/mini';
import { Input } from '@/components/ui/input';
import {
  buildRequest,
  bulkChange,
  exceedsCourseAccessLimit,
  filterCourses,
  indexCourses,
  isCourseOpen,
  requestSize,
  saveCourseAccess,
  unsavedMessage,
  withIntent,
  type CourseAccessRequest,
  type CourseAccessSaveOutcome,
  type CourseAccessSaveReport,
} from '@/lib/admin/course-access-selection';
import {
  clientRequest,
  readClientResponseJson,
  type ClientRequestFailure,
} from '@/lib/client-request';
import { ADMIN_COURSE_ACCESS_LIMIT } from '@/lib/constants';

type LoadedCourse = { id: string; title: string; slug: string; granted: boolean };
type CourseAccessItem = LoadedCourse & { searchKey: string };

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

const LIMIT_REACHED = `Можно открыть не больше ${ADMIN_COURSE_ACCESS_LIMIT} курсов.`;

/** Why a save was refused, by the code the route answers with. */
const refusalReasons: Record<string, string> = {
  COURSE_ACCESS_COURSE_UNKNOWN: 'Курс удалён.',
  ACCOUNT_UNAVAILABLE: 'Учётная запись недоступна.',
  COURSE_ACCESS_LIMIT: LIMIT_REACHED,
  RATE_LIMITED: 'Слишком много изменений подряд.',
  UNAUTHENTICATED: 'Войдите заново.',
  FORBIDDEN: 'Недостаточно прав.',
  CAPABILITY_REQUIRED: 'Недостаточно прав.',
};

/** A tick is saved after this pause, so three quick ticks become one request. */
const SAVE_DELAY_MS = 600;
const SAVED_NOTICE_MS = 1_800;
/** A longer list is searched rather than read through. */
const SEARCH_FROM = 10;
/** A longer list scrolls inside a box, so a search cannot move what is under it. */
const SCROLL_FROM = 8;

/**
 * Saves still on the wire, by learner. The card can be closed and opened again
 * while its last tick is being saved; the new card waits here before it reads,
 * or it would show the state from before that tick.
 */
const inflightSaves = new Map<string, Promise<void>>();

const TEXT_BUTTON = 'min-h-11 font-semibold underline underline-offset-4';
// Real buttons with a surface: the owner reads an underlined word as text, not as
// an action. The label grows under a search, so it may wrap inside its column.
const BULK_BUTTON =
  'min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 py-2 text-center text-sm font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-50';

function transportReason(failure: ClientRequestFailure, refused: boolean) {
  if (failure.kind === 'offline') return 'Нет сети.';
  if (failure.kind === 'timeout') return 'Сервер не ответил.';
  if (failure.kind !== 'http') return 'Нет связи с сервером.';
  return refused ? 'Сервер отклонил запрос.' : 'Сервис недоступен.';
}

function failedSave(failure: ClientRequestFailure, code: string): CourseAccessSaveOutcome {
  // A 4xx is the server saying no: nothing was written. Anything else — no
  // answer at all, or a 5xx — leaves the write unknown.
  const status = failure.kind === 'http' ? (failure.status ?? 0) : 0;
  const refused = status >= 400 && status < 500 && status !== 408;
  const named = Object.hasOwn(refusalReasons, code) ? refusalReasons[code] : undefined;
  return { ok: false, refused, code, reason: named ?? transportReason(failure, refused) };
}

async function getCourseAccess(userId: string, signal?: AbortSignal) {
  const result = await clientRequest(`/api/admin/users/${userId}/course-access`, {}, { signal });
  if (!result.ok) return null;
  const payload = coursesSchema.safeParse(await readClientResponseJson<unknown>(result.response));
  return payload.success ? payload.data.courses : null;
}

async function putCourseAccess(
  userId: string,
  request: CourseAccessRequest,
): Promise<CourseAccessSaveOutcome> {
  try {
    const result = await clientRequest(`/api/admin/users/${userId}/course-access`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const payload = await readClientResponseJson<unknown>(result.response);
    if (!result.ok) {
      const code =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error ?? '')
          : '';
      return failedSave(result.error, code);
    }
    const saved = savedSchema.safeParse(payload);
    if (!saved.success || saved.data.userId !== userId) {
      return { ok: false, refused: false, code: '', reason: 'Ответ сервера не подтверждён.' };
    }
    return { ok: true, courseIds: new Set(saved.data.courseIds) };
  } catch {
    return { ok: false, refused: false, code: '', reason: 'Нет связи с сервером.' };
  }
}

/**
 * Which courses this learner may open: one checkbox per course, and a tick is
 * saved on its own a moment later. The list used to end in a separate "Save
 * access" button that sat under the phone's navigation dock.
 *
 * A save carries only what changed ("open these, close those"). Sending the
 * whole ticked set closed the learner's unpublished courses, which this list
 * does not show, and overwrote a second administrator's change.
 */
export function CourseAccessControl({ userId, canManage }: { userId: string; canManage: boolean }) {
  const headingId = useId();
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [courses, setCourses] = useState<readonly CourseAccessItem[]>([]);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [query, setQuery] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [notice, setNotice] = useState<{
    message: string;
    retry: CourseAccessRequest | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // What the server last confirmed and what the administrator has asked for
  // since. They live in refs as well, so a save that finishes late compares
  // against the latest ticks instead of the render it started from.
  const confirmedRef = useRef<ReadonlySet<string>>(new Set());
  const pendingRef = useRef<ReadonlyMap<string, boolean>>(new Map());
  const coursesRef = useRef<readonly CourseAccessItem[]>([]);
  const savingRef = useRef(false);
  const aliveRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const clearAllRef = useRef<HTMLButtonElement>(null);
  const focusAfterBulkRef = useRef<'select' | 'clear' | null>(null);

  const commit = useCallback(
    (nextConfirmed: ReadonlySet<string>, nextPending: ReadonlyMap<string, boolean>) => {
      confirmedRef.current = nextConfirmed;
      pendingRef.current = nextPending;
      setConfirmed(nextConfirmed);
      setPending(nextPending);
    },
    [],
  );

  /** Takes a freshly read list; returns the courses it marks as open. */
  const adopt = useCallback((loaded: readonly LoadedCourse[]) => {
    const indexed = indexCourses(loaded);
    coursesRef.current = indexed;
    setCourses(indexed);
    return new Set(indexed.filter((course) => course.granted).map((course) => course.id));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setNotice(null);
    void (async () => {
      await inflightSaves.get(userId);
      if (controller.signal.aborted) return;
      const loaded = await getCourseAccess(userId, controller.signal);
      if (controller.signal.aborted) return;
      if (!loaded) {
        setState('failed');
        return;
      }
      commit(adopt(loaded), new Map());
      setState('ready');
    })().catch(() => {
      if (!controller.signal.aborted) setState('failed');
    });
    return () => controller.abort();
  }, [adopt, attempt, commit, userId]);

  const flush = useCallback(() => {
    timerRef.current = null;
    // One request at a time: the loop picks up whatever was ticked meanwhile.
    if (savingRef.current) return;
    savingRef.current = true;
    const save: Promise<void> = (async () => {
      const report = await saveCourseAccess({
        read: () => ({ confirmed: confirmedRef.current, pending: pendingRef.current }),
        commit,
        put: (request) => putCourseAccess(userId, request),
        // A card that has been closed has nobody to show the truth to; the
        // next opening reads it anyway.
        reload: async () => {
          const loaded = aliveRef.current ? await getCourseAccess(userId) : null;
          return loaded ? adopt(loaded) : null;
        },
        listedIds: () => new Set(coursesRef.current.map((course) => course.id)),
        saving: () => setSaveState('saving'),
      })
        // Nothing above is expected to throw. If it ever does, the ticks must
        // not stay on screen as though they were saved.
        .catch((): CourseAccessSaveReport => {
          const lost = buildRequest(pendingRef.current, confirmedRef.current);
          commit(confirmedRef.current, new Map());
          return { wrote: false, failure: { reason: 'Ошибка сохранения.', lost } };
        })
        .finally(() => {
          savingRef.current = false;
        });
      if (!aliveRef.current) return;
      if (report.failure) {
        const { lost, reason } = report.failure;
        const retryable = requestSize(lost) > 0;
        setSaveState('idle');
        setNotice({
          message: retryable
            ? unsavedMessage(
                lost,
                (courseId) => coursesRef.current.find((course) => course.id === courseId)?.title,
                reason,
              )
            : reason,
          retry: retryable ? lost : null,
        });
        return;
      }
      if (!report.wrote) {
        // A refused request whose box was toggled back meanwhile: nothing to say.
        setSaveState((current) => (current === 'saving' ? 'idle' : current));
        return;
      }
      setSaveState('saved');
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = window.setTimeout(() => {
        noticeTimerRef.current = null;
        setSaveState('idle');
      }, SAVED_NOTICE_MS);
    })()
      .catch(() => undefined)
      .then(() => {
        if (inflightSaves.get(userId) === save) inflightSaves.delete(userId);
      });
    inflightSaves.set(userId, save);
  }, [adopt, commit, userId]);

  // Closing the card right after a tick still saves that tick.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        flush();
      }
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, [flush]);

  // A bulk button that has done its work turns disabled. Focus moves to its
  // sibling — the undo — once that one is enabled, so the keyboard is never
  // left on a dead control. A failed save can disable the focused button too,
  // when the boxes return to what is saved.
  useEffect(() => {
    const select = selectAllRef.current;
    const clear = clearAllRef.current;
    const wanted = focusAfterBulkRef.current;
    focusAfterBulkRef.current = null;
    const active = document.activeElement;
    const target =
      wanted === 'select' || (!wanted && active === clear && clear?.disabled)
        ? select
        : wanted === 'clear' || (!wanted && active === select && select?.disabled)
          ? clear
          : null;
    if (target && !target.disabled) target.focus();
  }, [confirmed, pending]);

  const visible = useMemo(() => filterCourses(courses, query), [courses, query]);
  // An empty search hands back the list itself.
  const searching = visible !== courses;
  const openListed = useMemo(
    () => courses.filter((course) => isCourseOpen(course.id, confirmed, pending)).length,
    [confirmed, courses, pending],
  );
  const canSelect = bulkChange(visible, true, confirmed, pending).length > 0;
  const canClear = bulkChange(visible, false, confirmed, pending).length > 0;
  // A list that shrinks under a running search keeps the field that clears it.
  const searchable = courses.length > SEARCH_FROM || query !== '';
  const boxed = courses.length > SCROLL_FROM;

  const ask = (nextPending: ReadonlyMap<string, boolean>, bulk: boolean) => {
    if (exceedsCourseAccessLimit(confirmedRef.current, nextPending)) {
      setNotice({
        message: bulk ? `${LIMIT_REACHED} Уточните поиск.` : LIMIT_REACHED,
        retry: null,
      });
      return false;
    }
    pendingRef.current = nextPending;
    setPending(nextPending);
    setNotice(null);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, SAVE_DELAY_MS);
    return true;
  };

  const toggle = (courseId: string) => {
    const open = isCourseOpen(courseId, confirmedRef.current, pendingRef.current);
    ask(withIntent(pendingRef.current, [courseId], !open), false);
  };

  // Only what is on screen: under a search the hidden courses keep their state.
  const bulk = (target: boolean) => {
    const changed = bulkChange(visible, target, confirmedRef.current, pendingRef.current);
    if (changed.length === 0) return;
    if (ask(withIntent(pendingRef.current, changed, target), true)) {
      focusAfterBulkRef.current = target ? 'clear' : 'select';
    }
  };

  const retry = () => {
    const lost = notice?.retry;
    if (!lost) return;
    const again = withIntent(withIntent(pendingRef.current, lost.grant, true), lost.revoke, false);
    if (!ask(again, true)) return;
    // The button leaves with the alert; the keyboard goes on from the first
    // box it brought back, or from the search when that box is filtered out.
    const first = [...lost.grant, ...lost.revoke][0];
    (document.getElementById(`${headingId}-${first}`) ?? searchRef.current)?.focus();
  };

  const resetSearch = () => {
    setQuery('');
    searchRef.current?.focus();
  };

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-bold">
          Доступ к курсам
          {state === 'ready' ? (
            <span className="ml-1.5 font-semibold text-[var(--color-text-muted)] tabular-nums">
              {openListed}/{courses.length}
            </span>
          ) : null}
        </h3>
        {/* The width is reserved as well as the height: on a narrow screen the
            heading would otherwise re-wrap every time the status appears. */}
        <span
          role="status"
          className="w-24 shrink-0 text-right text-xs whitespace-nowrap text-[var(--color-text-muted)]"
        >
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
            className={TEXT_BUTTON}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </p>
      ) : courses.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Опубликованных курсов нет.</p>
      ) : (
        <>
          {searchable ? (
            <div>
              <Input
                ref={searchRef}
                type="search"
                aria-label="Поиск курса"
                placeholder="Поиск курса"
                enterKeyHint="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  // Escape empties the search first. The card is a native
                  // <dialog>: without this the same key press would close it.
                  if (event.key !== 'Escape' || !query) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }}
              />
              <p className="sr-only" aria-live="polite">
                {searching ? `Найдено курсов: ${visible.length}` : ''}
              </p>
            </div>
          ) : null}

          {canManage && courses.length > 1 ? (
            // Two fixed columns: the labels grow under a search, and a wrapping
            // row would push the list down.
            <div className="grid grid-cols-2 gap-x-2">
              <button
                ref={selectAllRef}
                type="button"
                className={BULK_BUTTON}
                disabled={!canSelect}
                onClick={() => bulk(true)}
              >
                {searching ? `Выбрать все найденные — ${visible.length}` : 'Выбрать все'}
              </button>
              <button
                ref={clearAllRef}
                type="button"
                className={BULK_BUTTON}
                disabled={!canClear}
                onClick={() => bulk(false)}
              >
                {searching ? `Снять найденные — ${visible.length}` : 'Снять все'}
              </button>
            </div>
          ) : null}

          {/* `h-64` is not in the stylesheet and the CSS budget is tight; these
              two existing utilities pin the box at the same 16rem. Disabled
              boxes take no focus, so a read-only list is scrolled by itself. */}
          <div
            className={boxed ? 'max-h-64 min-h-[16rem] overflow-y-auto' : undefined}
            {...(boxed && !canManage
              ? { tabIndex: 0, role: 'group', 'aria-label': 'Список курсов' }
              : {})}
          >
            {visible.length === 0 ? (
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-text-muted)]">
                Курсы не найдены.
                <button type="button" className={TEXT_BUTTON} onClick={resetSearch}>
                  Сбросить поиск
                </button>
              </p>
            ) : (
              // An explicit single column can shrink below its longest word; the
              // implicit one could not, and a classic scrollbar made the box
              // scroll sideways on a narrow screen.
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {visible.map((course) => {
                  const checked = isCourseOpen(course.id, confirmed, pending);
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
                          id={`${headingId}-${course.id}`}
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
          </div>
        </>
      )}

      {notice ? (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-danger)]"
        >
          {notice.message}
          {notice.retry ? (
            <button type="button" className={TEXT_BUTTON} onClick={retry}>
              Повторить
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
