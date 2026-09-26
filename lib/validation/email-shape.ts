/**
 * Email and sign-in code shapes without zod.
 *
 * The sign-in page is the page every new learner opens, and checking one email
 * and six digits with zod shipped its whole core (74 KB, 20 KB compressed) to
 * the browser. The server schemas in lib/validation/auth.ts use this same
 * pattern, so the two sides cannot disagree about what an address is.
 */

/** zod's own email pattern (zod/v4/core/regexes.js `email`). */
export const EMAIL_PATTERN =
  /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

export const EMAIL_MAX_LENGTH = 254;

export const OTP_CODE_PATTERN = /^\d{6}$/;

/** Trimmed, lower-cased address, or null when it is not an email address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

export function isOtpCode(value: unknown): value is string {
  return typeof value === 'string' && OTP_CODE_PATTERN.test(value);
}
