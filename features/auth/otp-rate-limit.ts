export const OTP_RETRY_FALLBACK_SECONDS = 60;
export const OTP_MAX_RETRY_SECONDS = 60 * 60;

type AuthProviderRateLimitError = { code?: string } | null;

export function authProviderRetryAfter(_error: AuthProviderRateLimitError) {
  // Supabase uses the same provider code for the per-address resend interval
  // and the project email bucket, while the SDK does not expose the bucket's
  // reset timestamp. Use the safe minimum cooldown instead of falsely locking
  // the browser for a full hour; a later 429 will extend it by another minute.
  return OTP_RETRY_FALLBACK_SECONDS;
}

function positiveSeconds(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : null;
}

function headerSeconds(value: string | null, nowMs: number) {
  const numeric = positiveSeconds(value);
  if (numeric !== null) return numeric;
  if (!value) return null;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) && retryAt > nowMs ? Math.ceil((retryAt - nowMs) / 1000) : null;
}

export function normalizeOtpRetryAfter(
  payloadValue: unknown,
  headerValue: string | null,
  fallbackSeconds = OTP_RETRY_FALLBACK_SECONDS,
  nowMs = Date.now(),
) {
  const candidates = [
    positiveSeconds(payloadValue),
    headerSeconds(headerValue, nowMs),
    positiveSeconds(fallbackSeconds),
  ].filter((value): value is number => value !== null);
  return Math.min(OTP_MAX_RETRY_SECONDS, Math.max(1, ...candidates));
}

export function isOtpRateLimited(errorCode: unknown, responseStatus: unknown) {
  return errorCode === 'RATE_LIMITED' || responseStatus === 429;
}

export function retrySecondsUntil(retryAt: number, nowMs = Date.now()) {
  if (!Number.isFinite(retryAt) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
}

export function formatRetryDelay(seconds: number) {
  const safeSeconds = Math.max(1, Math.ceil(seconds));
  if (safeSeconds < 60) return `${safeSeconds} с`;

  const totalMinutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (totalMinutes < 60) {
    return remainingSeconds > 0
      ? `${totalMinutes} мин ${remainingSeconds} с`
      : `${totalMinutes} мин`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes > 0 ? `${hours} ч ${remainingMinutes} мин` : `${hours} ч`;
}
