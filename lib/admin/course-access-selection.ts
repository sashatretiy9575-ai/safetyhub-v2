import { ADMIN_COURSE_ACCESS_LIMIT } from '../constants.ts';

/**
 * The arithmetic behind "Доступ к курсам" in the employee card.
 *
 * The card used to send the whole set of ticked courses. It lists only the
 * published ones, so every save silently closed a learner's unpublished
 * courses and overwrote whatever a second administrator had changed in the
 * meantime. A save now carries a delta — "open these, close those" — and the
 * server applies it to the grants it reads at that moment.
 *
 * `confirmed` is what the server last answered; `pending` holds one desired
 * state per course the administrator touched since. A box shows `confirmed`
 * overlaid with `pending`.
 */
export type CourseAccessRequest = { grant: string[]; revoke: string[] };

type Confirmed = ReadonlySet<string>;
type Pending = ReadonlyMap<string, boolean>;

/**
 * One spelling for the title and for what is typed: composed characters, lower
 * case, "ё" as "е", single spaces. NFC comes first so that a decomposed "ё"
 * (е + U+0308, as macOS keyboards and copied text produce it) becomes the one
 * letter the replacement looks for.
 */
export function normalizeCourseSearch(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Search keys are computed once per load, not on every keystroke. */
export function indexCourses<T extends { readonly title: string }>(
  courses: readonly T[],
): (T & { searchKey: string })[] {
  return courses.map((course) => ({ ...course, searchKey: normalizeCourseSearch(course.title) }));
}

/**
 * Every typed word has to occur in the title, in any order. An empty query
 * returns the array it was given — the same reference — so the caller can tell
 * "not searching" from "searching and everything matched".
 */
export function filterCourses<T extends { readonly searchKey: string }>(
  courses: readonly T[],
  query: string,
): readonly T[] {
  const words = normalizeCourseSearch(query).split(' ').filter(Boolean);
  if (words.length === 0) return courses;
  return courses.filter((course) => words.every((word) => course.searchKey.includes(word)));
}

/** What the box shows: the administrator's latest wish, else the saved state. */
export function isCourseOpen(courseId: string, confirmed: Confirmed, pending: Pending): boolean {
  return pending.get(courseId) ?? confirmed.has(courseId);
}

/**
 * The courses a "select all" / "clear all" press would change. It walks
 * `visible` and nothing else, so a bulk action under a search can never reach a
 * course that is filtered out. An empty answer means the button is disabled.
 */
export function bulkChange(
  visible: readonly { readonly id: string }[],
  target: boolean,
  confirmed: Confirmed,
  pending: Pending,
): string[] {
  return visible
    .filter((course) => isCourseOpen(course.id, confirmed, pending) !== target)
    .map((course) => course.id);
}

/**
 * Records a wish. It is written down even when it equals the saved state: a
 * save may be in flight, and an untick made meanwhile has to survive the
 * answer that is about to confirm the tick.
 */
export function withIntent(
  pending: Pending,
  courseIds: Iterable<string>,
  target: boolean,
): Map<string, boolean> {
  const next = new Map(pending);
  for (const courseId of courseIds) next.set(courseId, target);
  return next;
}

/** The delta to send: wishes that already hold on the server are left out. */
export function buildRequest(pending: Pending, confirmed: Confirmed): CourseAccessRequest {
  const grant: string[] = [];
  const revoke: string[] = [];
  for (const [courseId, open] of pending) {
    if (open === confirmed.has(courseId)) continue;
    (open ? grant : revoke).push(courseId);
  }
  // Sorted, so the same wishes always make the same request body.
  return { grant: grant.sort(), revoke: revoke.sort() };
}

export function requestSize(request: CourseAccessRequest): number {
  return request.grant.length + request.revoke.length;
}

/**
 * After an answer: a wish that went out with the request is settled, and so is
 * one that already holds. A box toggled again while the request was in flight
 * differs from what was sent, stays pending and makes the next request.
 */
export function settle(
  pending: Pending,
  sent: CourseAccessRequest,
  confirmedAfter: Confirmed,
): Map<string, boolean> {
  const answered = new Map<string, boolean>();
  for (const courseId of sent.grant) answered.set(courseId, true);
  for (const courseId of sent.revoke) answered.set(courseId, false);
  const next = new Map<string, boolean>();
  for (const [courseId, open] of pending) {
    if (answered.get(courseId) === open) continue;
    if (open === confirmedAfter.has(courseId)) continue;
    next.set(courseId, open);
  }
  return next;
}

/** A course deleted while the card was open cannot be asked for again. */
export function keepListed(
  request: CourseAccessRequest,
  listedIds: ReadonlySet<string>,
): CourseAccessRequest {
  return {
    grant: request.grant.filter((courseId) => listedIds.has(courseId)),
    revoke: request.revoke.filter((courseId) => listedIds.has(courseId)),
  };
}

/** How many courses would be open, counting the ones this card does not list. */
export function openCourseTotal(confirmed: Confirmed, pending: Pending): number {
  let total = confirmed.size;
  for (const [courseId, open] of pending) {
    if (open !== confirmed.has(courseId)) total += open ? 1 : -1;
  }
  return total;
}

export function exceedsCourseAccessLimit(confirmed: Confirmed, pending: Pending): boolean {
  return openCourseTotal(confirmed, pending) > ADMIN_COURSE_ACCESS_LIMIT;
}

/** One lost change is named by its course; several are counted. */
export function unsavedMessage(
  lost: CourseAccessRequest,
  titleOf: (courseId: string) => string | undefined,
  reason: string,
): string {
  const courseIds = [...lost.grant, ...lost.revoke];
  const only = courseIds.length === 1 ? courseIds[0] : undefined;
  const title = only === undefined ? undefined : titleOf(only);
  return title
    ? `Не сохранено: «${title}». ${reason}`
    : `Не сохранено изменений: ${courseIds.length}. ${reason}`;
}

export type CourseAccessSaveOutcome =
  | { ok: true; courseIds: ReadonlySet<string> }
  // `refused`: the server said no, so nothing was written. Otherwise the
  // request may have landed although its answer never arrived.
  | { ok: false; refused: boolean; code: string; reason: string };

/** The card's side of a save; the loop itself knows neither React nor fetch. */
export type CourseAccessSaveIo = {
  /** The latest state, asked again after every answer: boxes are ticked meanwhile. */
  read(): { confirmed: Confirmed; pending: Pending };
  commit(confirmed: Confirmed, pending: Pending): void;
  put(request: CourseAccessRequest): Promise<CourseAccessSaveOutcome>;
  /** Reads the list again: the open courses, or `null` when it cannot be read. */
  reload(): Promise<ReadonlySet<string> | null>;
  listedIds(): ReadonlySet<string>;
  /** A request is about to leave. */
  saving(): void;
};

export type CourseAccessSaveReport = {
  /** Something was written, so the card may say "Сохранено". */
  wrote: boolean;
  /** What is not saved and why. The boxes already show the saved state. */
  failure: { reason: string; lost: CourseAccessRequest } | null;
};

/**
 * Sends requests one after another until nothing is left to ask for. Callers
 * run one loop at a time, so two requests for a learner never overlap.
 *
 * A refusal leaves nothing written. A lost answer — timeout, dropped
 * connection, 5xx — says nothing about the write, so the list is read again
 * before anything is reported; a deleted course means the list itself is
 * stale, and is settled the same way. Either way the boxes return to what is
 * really saved, and everything still unsaved, ticks made during the request
 * included, goes into the report for the alert and its "Повторить".
 */
export async function saveCourseAccess(io: CourseAccessSaveIo): Promise<CourseAccessSaveReport> {
  let wrote = false;
  for (;;) {
    const { confirmed, pending } = io.read();
    const request = buildRequest(pending, confirmed);
    if (requestSize(request) === 0) {
      // Wishes that already hold (ticked and unticked again) are forgotten.
      io.commit(confirmed, settle(pending, request, confirmed));
      return { wrote, failure: null };
    }
    io.saving();
    const outcome = await io.put(request);
    if (outcome.ok) {
      io.commit(outcome.courseIds, settle(io.read().pending, request, outcome.courseIds));
      wrote = true;
      continue;
    }
    let truth = io.read().confirmed;
    if (!outcome.refused || outcome.code === 'COURSE_ACCESS_COURSE_UNKNOWN') {
      truth = (await io.reload()) ?? truth;
    }
    const unsaved = buildRequest(io.read().pending, truth);
    io.commit(truth, new Map());
    if (requestSize(unsaved) === 0) {
      // Nothing is left to ask for: the write landed although its answer was
      // lost, or the box was toggled back while the request was away.
      return { wrote: wrote || !outcome.refused, failure: null };
    }
    // A deleted course has left the list and cannot be asked for again.
    return {
      wrote,
      failure: { reason: outcome.reason, lost: keepListed(unsaved, io.listedIds()) },
    };
  }
}

/**
 * Server side: the delta applied to the grants read a moment ago. Courses the
 * request does not name keep their state, whoever set it and whether or not
 * they are published.
 */
export function applyCourseAccessRequest(
  current: Iterable<string>,
  request: CourseAccessRequest,
): string[] {
  const next = new Set(current);
  for (const courseId of request.revoke) next.delete(courseId);
  for (const courseId of request.grant) next.add(courseId);
  return [...next].sort();
}

/**
 * Server side, for a tab opened before the delta existed: its list is the whole
 * set as that card saw it, and the card saw only the offered (published)
 * courses. Grants outside the offer were never on its screen, so they stay.
 */
export function replaceListedCourseAccess(
  current: Iterable<string>,
  listedIds: Iterable<string>,
  courseIds: Iterable<string>,
): string[] {
  const listed = new Set(listedIds);
  const next = new Set(courseIds);
  for (const courseId of current) {
    if (!listed.has(courseId)) next.add(courseId);
  }
  return [...next].sort();
}
