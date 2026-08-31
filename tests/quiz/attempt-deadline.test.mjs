import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deadlineAnchorFromServer,
  formatDeadlineSeconds,
  remainingDeadlineSeconds,
} from '../../lib/attempt-deadline.ts';

test('the server deadline, not the client wall clock, creates the monotonic anchor', () => {
  const anchor = deadlineAnchorFromServer(
    '2026-08-01T10:05:00.000Z',
    '2026-08-01T10:00:00.000Z',
    12_500,
  );
  assert.equal(anchor, 312_500);
  assert.equal(remainingDeadlineSeconds(anchor, 12_500), 300);
  assert.equal(remainingDeadlineSeconds(anchor, 13_001), 300);
  assert.equal(remainingDeadlineSeconds(anchor, 311_501), 1);
});

test('equality and all times after the boundary are expired', () => {
  const equal = deadlineAnchorFromServer(
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T10:00:00.000Z',
    20,
  );
  const alreadyExpired = deadlineAnchorFromServer(
    '2026-08-01T09:59:59.999Z',
    '2026-08-01T10:00:00.000Z',
    20,
  );
  assert.equal(remainingDeadlineSeconds(equal, 20), 0);
  assert.equal(remainingDeadlineSeconds(alreadyExpired, 20), 0);
});

test('invalid server timestamps never create a client authority decision', () => {
  assert.equal(deadlineAnchorFromServer('invalid', '2026-08-01T10:00:00Z', 0), null);
  assert.equal(remainingDeadlineSeconds(null, 0), null);
  assert.equal(formatDeadlineSeconds(65), '01:05');
  assert.equal(formatDeadlineSeconds(-1), '00:00');
});
