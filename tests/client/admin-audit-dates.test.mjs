import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
