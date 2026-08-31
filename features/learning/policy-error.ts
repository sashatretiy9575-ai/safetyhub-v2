import type { AttemptPayload } from './types';

export type AttemptPolicyCode =
  | 'PROFILE_ONBOARDING_REQUIRED'
  | 'AVATAR_REQUIRED'
  | 'ATTEMPT_DAILY_LIMIT'
  | 'ATTEMPT_ROLLING_LIMIT'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_VARIANT_INVALID'
  | 'ATTEMPT_EXPIRED'
  | 'COURSE_CATALOG_MAINTENANCE';

function retryAtFromDetails(details?: string | null) {
  const value = details?.trim();
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as { retryAt?: unknown };
    if (typeof parsed.retryAt === 'string' && Number.isFinite(Date.parse(parsed.retryAt))) {
      return new Date(parsed.retryAt).toISOString();
    }
  } catch {
    // PostgreSQL may return either a plain timestamp or seconds in the DETAIL field.
  }

  const seconds = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  if (Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

export class AttemptPolicyError extends Error {
  public readonly code: AttemptPolicyCode;
  public readonly status: 409 | 429 | 503;
  public readonly retryAt?: string;
  public readonly retryAfterSeconds?: number;

  constructor(code: AttemptPolicyCode, status: 409 | 429 | 503, retryAt?: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
    if (retryAt) {
      this.retryAfterSeconds = Math.max(
        1,
        Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1000),
      );
    }
  }
}

export class AttemptExpiredError extends AttemptPolicyError {
  public readonly attempt: AttemptPayload;

  constructor(attempt: AttemptPayload) {
    super('ATTEMPT_EXPIRED', 409);
    this.attempt = attempt;
  }
}

export function parseAttemptRpcError(error: { message: string; details?: string | null }) {
  const codes: AttemptPolicyCode[] = [
    'PROFILE_ONBOARDING_REQUIRED',
    'AVATAR_REQUIRED',
    'ATTEMPT_DAILY_LIMIT',
    'ATTEMPT_ROLLING_LIMIT',
    'ATTEMPT_NOT_FOUND',
    'ATTEMPT_VARIANT_INVALID',
    'ATTEMPT_EXPIRED',
    'COURSE_CATALOG_MAINTENANCE',
  ];
  const code = codes.find((candidate) => error.message.includes(candidate));
  if (!code) return new Error(error.message);
  return new AttemptPolicyError(
    code,
    code === 'ATTEMPT_ROLLING_LIMIT' || code === 'ATTEMPT_DAILY_LIMIT'
      ? 429
      : code === 'COURSE_CATALOG_MAINTENANCE'
        ? 503
        : 409,
    code === 'ATTEMPT_ROLLING_LIMIT' || code === 'ATTEMPT_DAILY_LIMIT'
      ? retryAtFromDetails(error.details)
      : undefined,
  );
}
