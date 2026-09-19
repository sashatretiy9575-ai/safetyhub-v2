import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_QUICK_PERIODS,
  auditActivePeriod,
  auditDateBoundary,
  auditDateValue,
  auditInclusiveEndValue,
  auditRecentPeriod,
} from '../../lib/admin/audit-dates.ts';

test('audit local calendar boundaries include local midnight and exclude the next day', () => {
  const from = auditDateBoundary('2026-09-19');
  const to = auditDateBoundary('2026-09-19', true);
  assert.equal(from, '2026-09-18T19:00:00.000Z');
  assert.equal(to, '2026-09-19T19:00:00.000Z');
  for (const [instant, included] of [
    ['2026-09-18T18:59:59.999Z', false],
    ['2026-09-18T19:00:00.000Z', true],
    ['2026-09-19T18:59:59.999Z', true],
    ['2026-09-19T19:00:00.000Z', false],
  ])
    assert.equal(instant >= from && instant < to, included);
  assert.equal(auditDateValue(from), '2026-09-19');
  assert.equal(auditInclusiveEndValue(to), '2026-09-19');
});

test('audit rejects impossible dates and preserves leap-day/month/year transitions', () => {
  for (const invalid of [undefined, '', '2026-02-29', '2026-04-31', 'not-a-date']) {
    assert.equal(auditDateBoundary(invalid), null);
  }
  assert.equal(auditDateBoundary('2024-02-29', true), '2024-02-29T19:00:00.000Z');
  assert.deepEqual(auditRecentPeriod(7, new Date('2026-01-01T19:00:00Z')), {
    from: '2025-12-27',
    to: '2026-01-02',
  });
  assert.deepEqual(auditRecentPeriod(1, new Date('2026-09-18T19:00:00Z')), {
    from: '2026-09-19',
    to: '2026-09-19',
  });
});

test('audit active period names the applied shortcut and ignores hand-picked ranges', () => {
  // 17:00 in Kazakhstan on 19 September.
  const now = new Date('2026-09-19T12:00:00Z');
  assert.deepEqual([...AUDIT_QUICK_PERIODS], [1, 7, 30]);
  assert.equal(auditActivePeriod('2026-09-19', '2026-09-19', now), 1);
  assert.equal(auditActivePeriod('2026-09-13', '2026-09-19', now), 7);
  assert.equal(auditActivePeriod('2026-08-21', '2026-09-19', now), 30);
  for (const [from, to] of [
    ['2026-09-12', '2026-09-19'], // eight days
    ['2026-09-13', '2026-09-18'], // seven days that ended yesterday
    ['2026-09-19', '2026-09-13'], // reversed
    ['2026-09-13', ''],
    ['', '2026-09-19'],
    ['', ''],
  ]) {
    assert.equal(auditActivePeriod(from, to, now), null, `${from}..${to}`);
  }
});

test('audit active period turns over at local midnight and survives the filter round trip', () => {
  const lastLocalMoment = new Date('2026-09-19T18:59:59.999Z');
  // The local date is already the 20th while the UTC date is still the 19th.
  const localMidnight = new Date('2026-09-19T19:00:00.000Z');
  const lateUtcEvening = new Date('2026-09-19T23:30:00.000Z');
  assert.equal(auditActivePeriod('2026-09-19', '2026-09-19', lastLocalMoment), 1);
  assert.equal(auditActivePeriod('2026-09-13', '2026-09-19', lastLocalMoment), 7);
  for (const now of [localMidnight, lateUtcEvening]) {
    assert.equal(auditActivePeriod('2026-09-19', '2026-09-19', now), null);
    assert.equal(auditActivePeriod('2026-09-13', '2026-09-19', now), null);
    assert.equal(auditActivePeriod('2026-09-20', '2026-09-20', now), 1);
    assert.equal(auditActivePeriod('2026-09-14', '2026-09-20', now), 7);
    assert.equal(auditActivePeriod('2026-08-22', '2026-09-20', now), 30);
  }
  // The page never sees the link's own dates: it reads them back from the
  // parsed UTC boundaries, so that path has to land on the same shortcut.
  for (const now of [lastLocalMoment, localMidnight, new Date('2026-01-01T19:00:00Z')]) {
    for (const days of AUDIT_QUICK_PERIODS) {
      const period = auditRecentPeriod(days, now);
      const from = auditDateValue(auditDateBoundary(period.from));
      const to = auditInclusiveEndValue(auditDateBoundary(period.to, true));
      assert.deepEqual({ from, to }, period);
      assert.equal(auditActivePeriod(from, to, now), days);
    }
  }
});
