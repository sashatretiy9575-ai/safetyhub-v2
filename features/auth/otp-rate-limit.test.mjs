import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authProviderRetryAfter,
  formatRetryDelay,
  isOtpRateLimited,
  normalizeOtpRetryAfter,
  OTP_RETRY_FALLBACK_SECONDS,
  retrySecondsUntil,
} from './otp-rate-limit.ts';

test('provider throttles use a minute when the SDK exposes no reset timestamp', () => {
  assert.equal(
    authProviderRetryAfter({ code: 'over_email_send_rate_limit' }),
    OTP_RETRY_FALLBACK_SECONDS,
  );
  assert.equal(
    authProviderRetryAfter({ code: 'over_request_rate_limit' }),
    OTP_RETRY_FALLBACK_SECONDS,
  );
  assert.equal(authProviderRetryAfter(null), OTP_RETRY_FALLBACK_SECONDS);
});

test('retry delay uses the safest server signal, supports HTTP dates, and stays bounded', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  assert.equal(normalizeOtpRetryAfter(120, '90', 60, now), 120);
  assert.equal(normalizeOtpRetryAfter(undefined, 'Tue, 01 Sep 2026 00:05:00 GMT', 60, now), 300);
  assert.equal(normalizeOtpRetryAfter('invalid', null, 60, now), 60);
  assert.equal(normalizeOtpRetryAfter(99_999, null, 60, now), 3600);
});

test('HTTP 429 remains rate-limited even when its JSON body is absent or invalid', () => {
  assert.equal(isOtpRateLimited('RATE_LIMITED', undefined), true);
  assert.equal(isOtpRateLimited(undefined, 429), true);
  assert.equal(isOtpRateLimited('OTP_UNAVAILABLE', 503), false);
});

test('countdown derives from the deadline after a suspended tab skips interval ticks', () => {
  const retryAt = Date.parse('2026-09-01T00:01:00.000Z');
  assert.equal(retrySecondsUntil(retryAt, Date.parse('2026-09-01T00:00:00.000Z')), 60);
  assert.equal(retrySecondsUntil(retryAt, Date.parse('2026-09-01T00:00:45.500Z')), 15);
  assert.equal(retrySecondsUntil(retryAt, Date.parse('2026-09-01T00:05:00.000Z')), 0);
});

test('retry delay is rendered compactly for seconds, minutes, and hours', () => {
  assert.equal(formatRetryDelay(9), '9 с');
  assert.equal(formatRetryDelay(60), '1 мин');
  assert.equal(formatRetryDelay(125), '2 мин 5 с');
  assert.equal(formatRetryDelay(3600), '1 ч');
});
