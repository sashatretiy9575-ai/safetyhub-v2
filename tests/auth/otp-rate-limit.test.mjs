import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAuthProviderError,
  DEFAULT_PROVIDER_EMAILS_PER_HOUR,
  formatRetryDelay,
  isOtpRateLimited,
  normalizeOtpRetryAfter,
  OTP_RETRY_FALLBACK_SECONDS,
  providerEmailsPerHour,
  retrySecondsUntil,
} from '../../lib/auth/otp-rate-limit.ts';

test('the three provider refusals become three different answers', () => {
  // Per-address resend interval: the person already has a code on the way.
  assert.deepEqual(
    classifyAuthProviderError({
      code: 'over_email_send_rate_limit',
      message: 'For security purposes, you can only request this after 47 seconds.',
      status: 429,
    }),
    { code: 'ADDRESS_COOLDOWN', retryAfter: 47 },
  );
  // Project-wide hourly bucket: one slot frees up every 3600 / email_sent seconds.
  assert.deepEqual(
    classifyAuthProviderError({ code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }),
    { code: 'PROVIDER_BUSY', retryAfter: 90 },
  );
  assert.deepEqual(
    classifyAuthProviderError({ code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }, 30),
    { code: 'PROVIDER_BUSY', retryAfter: 120 },
  );
  // A very generous budget never promises less than the minute the form already enforces.
  assert.equal(
    classifyAuthProviderError({ code: 'over_email_send_rate_limit', message: '' }, 3600).retryAfter,
    OTP_RETRY_FALLBACK_SECONDS,
  );
  assert.deepEqual(
    classifyAuthProviderError({ code: 'over_request_rate_limit', message: 'Request rate limit reached' }),
    { code: 'PROVIDER_BUSY', retryAfter: OTP_RETRY_FALLBACK_SECONDS },
  );
  assert.deepEqual(classifyAuthProviderError(null), {
    code: 'RATE_LIMITED',
    retryAfter: OTP_RETRY_FALLBACK_SECONDS,
  });
  assert.equal(DEFAULT_PROVIDER_EMAILS_PER_HOUR, 40);
});

test('the hourly budget comes from the environment and falls back to the config value', () => {
  assert.equal(providerEmailsPerHour('40'), 40);
  assert.equal(providerEmailsPerHour('200'), 200);
  assert.equal(providerEmailsPerHour(undefined), DEFAULT_PROVIDER_EMAILS_PER_HOUR);
  assert.equal(providerEmailsPerHour('0'), DEFAULT_PROVIDER_EMAILS_PER_HOUR);
  assert.equal(providerEmailsPerHour('forty'), DEFAULT_PROVIDER_EMAILS_PER_HOUR);
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
  assert.equal(isOtpRateLimited('PROVIDER_BUSY', undefined), true);
  assert.equal(isOtpRateLimited('ADDRESS_COOLDOWN', undefined), true);
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
  const ru = { second: 'с', minute: 'мин', hour: 'ч' };
  assert.equal(formatRetryDelay(9, ru), '9 с');
  assert.equal(formatRetryDelay(60, ru), '1 мин');
  assert.equal(formatRetryDelay(125, ru), '2 мин 5 с');
  assert.equal(formatRetryDelay(3600, ru), '1 ч');
});
