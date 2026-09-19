import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCourseAccessRequest,
  buildRequest,
  bulkChange,
  exceedsCourseAccessLimit,
  filterCourses,
  indexCourses,
  isCourseOpen,
  keepListed,
  normalizeCourseSearch,
  openCourseTotal,
  replaceListedCourseAccess,
  requestSize,
  saveCourseAccess,
  settle,
  unsavedMessage,
  withIntent,
} from '../../lib/admin/course-access-selection.ts';
import { ADMIN_COURSE_ACCESS_LIMIT } from '../../lib/constants.ts';

const catalogue = indexCourses([
  { id: 'fire', title: 'Пожарная безопасность' },
  { id: 'industrial', title: 'Промышленная  безопасность' },
  { id: 'rigging', title: 'Стропальщик: подъёмные работы' },
  { id: 'welder', title: 'Сварщик' },
  { id: 'biot', title: 'БИОТ' },
]);
const ids = (courses) => courses.map((course) => course.id);

test('titles and queries share one spelling: case, ё, composed letters and spaces', () => {
  assert.equal(normalizeCourseSearch('  ПОЖАРНАЯ   Безопасность '), 'пожарная безопасность');
  assert.equal(normalizeCourseSearch('Подъёмные'), 'подъемные');
  // "ё" and "й" typed as a letter plus a combining mark (U+0308, U+0306).
  assert.equal(normalizeCourseSearch('подъе\u0308мные'), 'подъемные');
  assert.equal(normalizeCourseSearch('и\u0306од'), 'йод');
  assert.equal(normalizeCourseSearch('Ё'), 'е');
  // The key is computed once, when the list arrives.
  assert.equal(catalogue[1].searchKey, 'промышленная безопасность');
  assert.equal(catalogue[1].title, 'Промышленная  безопасность');
});

test('an empty search hands back the very same list', () => {
  assert.equal(filterCourses(catalogue, ''), catalogue);
  assert.equal(filterCourses(catalogue, '   '), catalogue);
  assert.notEqual(filterCourses(catalogue, 'а'), catalogue);
});

test('every typed word has to occur in the title, in any order', () => {
  assert.deepEqual(ids(filterCourses(catalogue, 'безопасн')), ['fire', 'industrial']);
  assert.deepEqual(ids(filterCourses(catalogue, 'безопасность ПОЖАР')), ['fire']);
  assert.deepEqual(ids(filterCourses(catalogue, 'подъемные')), ['rigging']);
  assert.deepEqual(ids(filterCourses(catalogue, 'ПОДЪЁМНЫЕ')), ['rigging']);
  assert.deepEqual(ids(filterCourses(catalogue, 'биот')), ['biot']);
  assert.deepEqual(ids(filterCourses(catalogue, 'сварщик крана')), []);
});

test('a box shows the latest wish, else the saved state', () => {
  const confirmed = new Set(['fire']);
  const pending = new Map([
    ['fire', false],
    ['welder', true],
  ]);
  assert.equal(isCourseOpen('fire', confirmed, pending), false);
  assert.equal(isCourseOpen('welder', confirmed, pending), true);
  assert.equal(isCourseOpen('biot', confirmed, pending), false);
  assert.equal(isCourseOpen('fire', confirmed, new Map()), true);
});

test('a bulk press changes only what is on screen and only what differs', () => {
  const confirmed = new Set(['fire', 'welder']);
  const pending = new Map([['industrial', true]]);
  const visible = filterCourses(catalogue, 'безопасность');
  // Both visible courses are open already: "select all found" has nothing to do.
  assert.deepEqual(bulkChange(visible, true, confirmed, pending), []);
  assert.deepEqual(bulkChange(visible, false, confirmed, pending), ['fire', 'industrial']);
  // The hidden "welder" stays open whatever is pressed under this search.
  for (const target of [true, false]) {
    const changed = bulkChange(visible, target, confirmed, pending);
    assert.ok(changed.every((id) => ids(visible).includes(id)));
    assert.ok(!changed.includes('welder'));
  }
  assert.deepEqual(bulkChange(catalogue, true, confirmed, pending), ['rigging', 'biot']);
  assert.deepEqual(bulkChange([], true, confirmed, pending), []);
});

test('a wish is recorded without touching the map it came from', () => {
  const pending = new Map([['fire', true]]);
  const next = withIntent(pending, ['fire', 'biot'], false);
  assert.deepEqual(
    [...next],
    [
      ['fire', false],
      ['biot', false],
    ],
  );
  assert.deepEqual([...pending], [['fire', true]]);
});

test('the request carries the delta and drops wishes that already hold', () => {
  const confirmed = new Set(['fire', 'welder']);
  const pending = new Map([
    ['welder', false],
    ['biot', true],
    ['fire', true], // already open
    ['rigging', false], // already closed
    ['industrial', true],
  ]);
  const request = buildRequest(pending, confirmed);
  assert.deepEqual(request, { grant: ['biot', 'industrial'], revoke: ['welder'] });
  assert.equal(requestSize(request), 3);
  assert.deepEqual(buildRequest(new Map([['fire', true]]), confirmed), { grant: [], revoke: [] });
  assert.equal(requestSize(buildRequest(new Map(), confirmed)), 0);
});

test('an answer settles what was sent and keeps a box toggled during the flight', () => {
  const sent = { grant: ['fire', 'biot'], revoke: ['welder'] };
  // While the request was away: "fire" was unticked again, "rigging" ticked,
  // "industrial" ticked and unticked.
  const pending = new Map([
    ['fire', false],
    ['biot', true],
    ['welder', false],
    ['rigging', true],
    ['industrial', false],
  ]);
  const confirmedAfter = new Set(['fire', 'biot']);
  const left = settle(pending, sent, confirmedAfter);
  assert.deepEqual(
    [...left],
    [
      ['fire', false],
      ['rigging', true],
    ],
  );
  // The survivors make the next request, and its answer empties the map.
  const next = buildRequest(left, confirmedAfter);
  assert.deepEqual(next, { grant: ['rigging'], revoke: ['fire'] });
  assert.equal(settle(left, next, new Set(['biot', 'rigging'])).size, 0);
});

test('a sent wish is settled even when the answer disagrees, so the box shows the server', () => {
  const pending = new Map([['fire', true]]);
  const left = settle(pending, { grant: ['fire'], revoke: [] }, new Set());
  assert.equal(left.size, 0);
  assert.equal(isCourseOpen('fire', new Set(), left), false);
});

test('with nothing sent, settling only prunes the wishes that already hold', () => {
  const confirmed = new Set(['fire']);
  const pending = new Map([
    ['fire', true],
    ['biot', false],
    ['welder', true],
  ]);
  assert.deepEqual([...settle(pending, { grant: [], revoke: [] }, confirmed)], [['welder', true]]);
});

test('a retry cannot ask for a course that has left the list', () => {
  const lost = { grant: ['fire', 'gone'], revoke: ['gone-too', 'welder'] };
  assert.deepEqual(keepListed(lost, new Set(['fire', 'welder', 'biot'])), {
    grant: ['fire'],
    revoke: ['welder'],
  });
});

test('the limit counts what would be open, unlisted grants included', () => {
  const confirmed = new Set(
    Array.from({ length: ADMIN_COURSE_ACCESS_LIMIT }, (_, index) => `course-${index}`),
  );
  assert.equal(ADMIN_COURSE_ACCESS_LIMIT, 200);
  assert.equal(openCourseTotal(confirmed, new Map()), 200);
  assert.equal(exceedsCourseAccessLimit(confirmed, new Map()), false);
  assert.equal(exceedsCourseAccessLimit(confirmed, new Map([['extra', true]])), true);
  // Closing one makes room for another; a wish that already holds counts for nothing.
  const swap = new Map([
    ['extra', true],
    ['course-0', false],
    ['course-1', true],
    ['never-open', false],
  ]);
  assert.equal(openCourseTotal(confirmed, swap), 200);
  assert.equal(exceedsCourseAccessLimit(confirmed, swap), false);
});

test('one lost change is named, several are counted', () => {
  const titleOf = (id) => catalogue.find((course) => course.id === id)?.title;
  assert.equal(
    unsavedMessage({ grant: ['welder'], revoke: [] }, titleOf, 'Нет сети.'),
    'Не сохранено: «Сварщик». Нет сети.',
  );
  assert.equal(
    unsavedMessage({ grant: ['welder'], revoke: ['fire', 'biot'] }, titleOf, 'Нет сети.'),
    'Не сохранено изменений: 3. Нет сети.',
  );
  // A course that is no longer listed has no title to show.
  assert.equal(
    unsavedMessage({ grant: [], revoke: ['gone'] }, titleOf, 'Нет сети.'),
    'Не сохранено изменений: 1. Нет сети.',
  );
});

/**
 * The card without React: its two pieces of state, a server that applies a
 * delta the way the route does, and a script of answers. `during` runs while
 * the request is away, which is when an administrator keeps ticking.
 */
function card({ confirmed = [], server = confirmed, answers = [] } = {}) {
  const state = { confirmed: new Set(confirmed), pending: new Map() };
  const world = { server: new Set(server), listed: new Set(ids(catalogue)), reloadFails: false };
  const log = { puts: [], reloads: 0, saving: 0, inFlight: 0, overlapped: false };
  const failures = {
    refused: { refused: true, code: 'RATE_LIMITED', reason: 'Слишком много изменений подряд.' },
    lost: { refused: false, code: '', reason: 'Сервер не ответил.' },
    'written-but-lost': { refused: false, code: '', reason: 'Сервер не ответил.' },
    'course-unknown': {
      refused: true,
      code: 'COURSE_ACCESS_COURSE_UNKNOWN',
      reason: 'Курс удалён.',
    },
  };
  const tick = (id) => {
    const open = isCourseOpen(id, state.confirmed, state.pending);
    state.pending = withIntent(state.pending, [id], !open);
  };
  const io = {
    read: () => ({ confirmed: state.confirmed, pending: state.pending }),
    commit(nextConfirmed, nextPending) {
      state.confirmed = nextConfirmed;
      state.pending = nextPending;
    },
    async put(request) {
      log.puts.push(request);
      log.inFlight += 1;
      if (log.inFlight > 1) log.overlapped = true;
      const { during, result = 'ok' } = answers.shift() ?? {};
      await Promise.resolve();
      during?.();
      if (result === 'ok' || result === 'written-but-lost') {
        world.server = new Set(applyCourseAccessRequest(world.server, request));
      }
      log.inFlight -= 1;
      return result === 'ok'
        ? { ok: true, courseIds: new Set(world.server) }
        : { ok: false, ...failures[result] };
    },
    // Like the GET: only the listed courses come back.
    async reload() {
      log.reloads += 1;
      if (world.reloadFails) return null;
      return new Set([...world.server].filter((id) => world.listed.has(id)));
    },
    listedIds: () => world.listed,
    saving: () => {
      log.saving += 1;
    },
  };
  return { state, world, log, tick, save: () => saveCourseAccess(io) };
}

test('quick ticks make one request, and courses the card does not list stay open', async () => {
  // "draft" is unpublished, so the card has never seen it.
  const { state, world, log, tick, save } = card({ confirmed: [], server: ['draft'] });
  tick('fire');
  tick('welder');
  tick('welder');
  assert.deepEqual(await save(), { wrote: true, failure: null });
  assert.deepEqual(log.puts, [{ grant: ['fire'], revoke: [] }]);
  assert.deepEqual([...world.server].sort(), ['draft', 'fire']);
  assert.deepEqual([...state.confirmed].sort(), ['draft', 'fire']);
  assert.equal(state.pending.size, 0);
});

test('a box toggled while the request is away makes the next request, never a parallel one', async () => {
  const session = card({
    answers: [
      {
        during: () => {
          session.tick('fire');
          session.tick('biot');
        },
      },
    ],
  });
  session.tick('fire');
  assert.deepEqual(await session.save(), { wrote: true, failure: null });
  assert.deepEqual(session.log.puts, [
    { grant: ['fire'], revoke: [] },
    { grant: ['biot'], revoke: ['fire'] },
  ]);
  assert.equal(session.log.overlapped, false);
  assert.equal(session.log.saving, 2);
  assert.deepEqual([...session.world.server], ['biot']);
  assert.deepEqual([...session.state.confirmed], ['biot']);
  assert.equal(session.state.pending.size, 0);
});

test('a refusal returns the boxes to the saved state and reports everything unsaved', async () => {
  const session = card({
    confirmed: ['fire'],
    answers: [{ during: () => session.tick('biot'), result: 'refused' }],
  });
  session.tick('welder');
  const report = await session.save();
  assert.deepEqual(report, {
    wrote: false,
    failure: {
      reason: 'Слишком много изменений подряд.',
      lost: { grant: ['biot', 'welder'], revoke: [] },
    },
  });
  // The server said no: nothing is read again, nothing more is sent.
  assert.equal(session.log.reloads, 0);
  assert.equal(session.log.puts.length, 1);
  assert.deepEqual([...session.state.confirmed], ['fire']);
  assert.equal(session.state.pending.size, 0);
  assert.deepEqual([...session.world.server], ['fire']);
  // "Повторить" asks for the same delta again, and this time it lands.
  session.state.pending = withIntent(session.state.pending, report.failure.lost.grant, true);
  assert.deepEqual(await session.save(), { wrote: true, failure: null });
  assert.deepEqual([...session.world.server].sort(), ['biot', 'fire', 'welder']);
});

test('a lost answer is checked against the server before anything is reported', async () => {
  const landed = card({ answers: [{ result: 'written-but-lost' }] });
  landed.tick('welder');
  assert.deepEqual(await landed.save(), { wrote: true, failure: null });
  assert.equal(landed.log.reloads, 1);
  assert.deepEqual([...landed.state.confirmed], ['welder']);
  assert.equal(landed.state.pending.size, 0);

  const dropped = card({ confirmed: ['fire'], answers: [{ result: 'lost' }] });
  dropped.tick('welder');
  dropped.tick('fire');
  assert.deepEqual(await dropped.save(), {
    wrote: false,
    failure: { reason: 'Сервер не ответил.', lost: { grant: ['welder'], revoke: ['fire'] } },
  });
  assert.equal(dropped.log.reloads, 1);
  assert.deepEqual([...dropped.state.confirmed], ['fire']);
  assert.equal(dropped.state.pending.size, 0);
});

test('when the truth cannot be read either, the last known state is shown', async () => {
  const session = card({ confirmed: ['fire'], answers: [{ result: 'written-but-lost' }] });
  session.world.reloadFails = true;
  session.tick('welder');
  const report = await session.save();
  assert.deepEqual(report.failure.lost, { grant: ['welder'], revoke: [] });
  assert.deepEqual([...session.state.confirmed], ['fire']);
  // The retry repeats a write that did land; the delta makes that harmless.
  session.state.pending = withIntent(session.state.pending, report.failure.lost.grant, true);
  assert.deepEqual(await session.save(), { wrote: true, failure: null });
  assert.deepEqual([...session.world.server].sort(), ['fire', 'welder']);
  assert.deepEqual([...session.state.confirmed].sort(), ['fire', 'welder']);
});

test('a deleted course refreshes the list and is left out of the retry', async () => {
  const session = card({
    answers: [{ during: () => session.world.listed.delete('welder'), result: 'course-unknown' }],
  });
  session.tick('fire');
  session.tick('welder');
  assert.deepEqual(await session.save(), {
    wrote: false,
    failure: { reason: 'Курс удалён.', lost: { grant: ['fire'], revoke: [] } },
  });
  assert.equal(session.log.reloads, 1);

  const alone = card({
    answers: [{ during: () => alone.world.listed.delete('welder'), result: 'course-unknown' }],
  });
  alone.tick('welder');
  const report = await alone.save();
  assert.equal(report.failure.reason, 'Курс удалён.');
  assert.equal(requestSize(report.failure.lost), 0);
});

test('a refused request whose box was toggled back leaves nothing to report', async () => {
  const session = card({ answers: [{ during: () => session.tick('fire'), result: 'refused' }] });
  session.tick('fire');
  assert.deepEqual(await session.save(), { wrote: false, failure: null });
  assert.equal(session.state.pending.size, 0);
  assert.equal(session.state.confirmed.size, 0);
});

test('ticking and unticking before the save sends nothing', async () => {
  const { state, log, tick, save } = card({ confirmed: ['fire'] });
  tick('fire');
  tick('fire');
  tick('biot');
  tick('biot');
  assert.deepEqual(await save(), { wrote: false, failure: null });
  assert.equal(log.puts.length, 0);
  assert.equal(log.saving, 0);
  assert.equal(state.pending.size, 0);
});

test('the server applies the delta to the grants it has just read', () => {
  // "draft" is a grant to an unpublished course; "second" was opened by another
  // administrator after this card was loaded. Neither is named, both survive.
  const current = ['draft', 'fire', 'second'];
  assert.deepEqual(applyCourseAccessRequest(current, { grant: ['biot'], revoke: ['fire'] }), [
    'biot',
    'draft',
    'second',
  ]);
  // Repeating a request that already landed changes nothing.
  assert.deepEqual(
    applyCourseAccessRequest(['biot', 'draft', 'second'], { grant: ['biot'], revoke: ['fire'] }),
    ['biot', 'draft', 'second'],
  );
  assert.deepEqual(applyCourseAccessRequest([], { grant: [], revoke: ['fire'] }), []);
  assert.deepEqual(current, ['draft', 'fire', 'second']);
});

test('a whole-set body from an old tab replaces only the courses that tab could see', () => {
  const listed = ['fire', 'welder', 'biot'];
  assert.deepEqual(replaceListedCourseAccess(['draft', 'fire', 'welder'], listed, ['biot']), [
    'biot',
    'draft',
  ]);
  assert.deepEqual(replaceListedCourseAccess(['draft', 'fire'], listed, []), ['draft']);
  assert.deepEqual(replaceListedCourseAccess([], listed, ['welder', 'fire', 'fire']), [
    'fire',
    'welder',
  ]);
});
