import assert from 'node:assert/strict';
import test from 'node:test';
import { AttemptPolicyError, parseAttemptRpcError } from './policy-error.ts';

test('legacy rolling-deploy limit preserves its domain code and exact retry timestamp', () => {
  const error = parseAttemptRpcError({
    message: 'ATTEMPT_ROLLING_LIMIT',
    details: '2026-09-12T08:30:00.000Z',
  });
  assert.ok(error instanceof AttemptPolicyError);
  assert.equal(error.code, 'ATTEMPT_ROLLING_LIMIT');
  assert.equal(error.status, 429);
  assert.equal(error.retryAt, '2026-09-12T08:30:00.000Z');
});

test('legacy rolling-deploy limit accepts a structured PostgreSQL DETAIL payload', () => {
  const error = parseAttemptRpcError({
    message: 'ATTEMPT_ROLLING_LIMIT',
    details: '{"retryAt":"2026-09-12T08:30:00Z"}',
  });
  assert.ok(error instanceof AttemptPolicyError);
  assert.equal(error.retryAt, '2026-09-12T08:30:00.000Z');
});

test('daily limit preserves its domain code and calendar-day retry timestamp', () => {
  const error = parseAttemptRpcError({
    message: 'ATTEMPT_DAILY_LIMIT',
    details: '{"retryAt":"2026-09-13T00:00:00+05:00"}',
  });
  assert.equal(error instanceof AttemptPolicyError, true);
  assert.equal(error.code, 'ATTEMPT_DAILY_LIMIT');
  assert.equal(error.status, 429);
  assert.equal(error.retryAt, '2026-09-12T19:00:00.000Z');
});

test('catalog maintenance is a safe temporary learner outage', () => {
  const error = parseAttemptRpcError({ message: 'COURSE_CATALOG_MAINTENANCE' });
  assert.ok(error instanceof AttemptPolicyError);
  assert.equal(error.code, 'COURSE_CATALOG_MAINTENANCE');
  assert.equal(error.status, 503);
  assert.equal(error.retryAt, undefined);
});

test('onboarding conflicts remain explicit 409 errors', () => {
  const error = parseAttemptRpcError({ message: 'PROFILE_ONBOARDING_REQUIRED' });
  assert.ok(error instanceof AttemptPolicyError);
  assert.equal(error.code, 'PROFILE_ONBOARDING_REQUIRED');
  assert.equal(error.status, 409);
});

test('a missing required avatar remains an explicit onboarding conflict', () => {
  const error = parseAttemptRpcError({ message: 'AVATAR_REQUIRED' });
  assert.ok(error instanceof AttemptPolicyError);
  assert.equal(error.code, 'AVATAR_REQUIRED');
  assert.equal(error.status, 409);
});

test('unrelated database failures are not misclassified', () => {
  const error = parseAttemptRpcError({ message: 'CONNECTION_FAILURE' });
  assert.ok(!(error instanceof AttemptPolicyError));
  assert.equal(error.message, 'CONNECTION_FAILURE');
});
