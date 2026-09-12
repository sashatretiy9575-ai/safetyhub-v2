export const OTP_RETRY_FALLBACK_SECONDS = 60;
export const OTP_MAX_RETRY_SECONDS = 60 * 60;
/** Mirrors `[auth.rate_limit] email_sent` in supabase/config.toml. */
export const DEFAULT_PROVIDER_EMAILS_PER_HOUR = 100;

export type AuthProviderThrottleCode = 'ADDRESS_COOLDOWN' | 'PROVIDER_BUSY' | 'RATE_LIMITED';

export type AuthProviderThrottle = Readonly<{
  code: AuthProviderThrottleCode;
  retryAfter: number;
}>;

type AuthProviderRateLimitError = { code?: string; message?: string; status?: number } | null;

/** The configured hourly email budget, or the default when the variable is absent or malformed. */
export function providerEmailsPerHour(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100_000
    ? parsed
    : DEFAULT_PROVIDER_EMAILS_PER_HOUR;
}

/**
 * Supabase answers 429 for three different reasons, and only one of them is
 * "you, personally, asked too fast". Telling them apart is what lets the form
 * say something true instead of "wait a minute" on every refusal:
 *
 * - `over_email_send_rate_limit` with "after N seconds" is the per-address
 *   resend interval (`max_frequency`): the person already has a code on the
 *   way and may ask again in N seconds.
 * - the same code without a number is the project-wide hourly email bucket:
 *   everybody is waiting for it to refill, and one slot frees up every
 *   3600 / email_sent seconds. The SDK exposes no reset timestamp.
 * - `over_request_rate_limit` is the general request limit of the Auth API.
 */
export function classifyAuthProviderError(
  error: AuthProviderRateLimitError,
  emailsPerHour = DEFAULT_PROVIDER_EMAILS_PER_HOUR,
): AuthProviderThrottle {
  const message = typeof error?.message === 'string' ? error.message : '';
  const cooldown = /after (\d{1,5}) seconds?/iu.exec(message);
  if (cooldown && error?.code === 'over_email_send_rate_limit') {
    return {
      code: 'ADDRESS_COOLDOWN',
      retryAfter: Math.min(OTP_MAX_RETRY_SECONDS, Math.max(1, Number(cooldown[1]))),
    };
  }
  if (error?.code === 'over_email_send_rate_limit') {
    return {
      code: 'PROVIDER_BUSY',
      retryAfter: Math.min(
        OTP_MAX_RETRY_SECONDS,
        Math.max(OTP_RETRY_FALLBACK_SECONDS, Math.ceil(3600 / Math.max(1, emailsPerHour))),
      ),
    };
  }
  if (error?.code === 'over_request_rate_limit') {
    return { code: 'PROVIDER_BUSY', retryAfter: OTP_RETRY_FALLBACK_SECONDS };
  }
  return { code: 'RATE_LIMITED', retryAfter: OTP_RETRY_FALLBACK_SECONDS };
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
  return (
    errorCode === 'RATE_LIMITED' ||
    errorCode === 'PROVIDER_BUSY' ||
    errorCode === 'ADDRESS_COOLDOWN' ||
    responseStatus === 429
  );
}

export function retrySecondsUntil(retryAt: number, nowMs = Date.now()) {
  if (!Number.isFinite(retryAt) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
}

export type RetryDelayUnits = Readonly<{ second: string; minute: string; hour: string }>;

/**
 * The units come from AuthOtp.retryUnits, never from this module: a second copy
 * of four translations here meant the Kazakh abbreviation for "second" was the
 * Russian one, and nothing in the catalog tests could see it.
 */
export function formatRetryDelay(seconds: number, units: RetryDelayUnits) {
  const safeSeconds = Math.max(1, Math.ceil(seconds));
  if (safeSeconds < 60) return `${safeSeconds} ${units.second}`;

  const totalMinutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (totalMinutes < 60) {
    return remainingSeconds > 0
      ? `${totalMinutes} ${units.minute} ${remainingSeconds} ${units.second}`
      : `${totalMinutes} ${units.minute}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes > 0
    ? `${hours} ${units.hour} ${remainingMinutes} ${units.minute}`
    : `${hours} ${units.hour}`;
}
