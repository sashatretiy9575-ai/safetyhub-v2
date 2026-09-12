import * as z from 'zod/mini';

// zod/mini on purpose: this schema runs in the browser on the login page, and
// the classic API ships every locale plus the JSON-Schema compiler with it.
const normalizedEmailSchema = z
  .string()
  .check(z.trim(), z.toLowerCase(), z.regex(z.regexes.email), z.maxLength(254));
const captchaTokenSchema = z.optional(z.string().check(z.minLength(1), z.maxLength(4096)));
const emailOtpLocaleSchema = z.optional(z.enum(['ru', 'kk', 'en']));

/**
 * Passwordless email entry point. It intentionally accepts both a new and an
 * existing address through the same code flow, so the server never exposes
 * whether an address already has an account.
 *
 * Everything password-shaped that used to live here — the strength schema, the
 * sign-in and sign-up bodies, the reset and update-password bodies, the change
 * request union and the invite context — had no reader left once the email
 * realm went code-only. The Chinese realm still uses a password, and it has
 * always validated it in features/auth/zh-username-password-validation.ts.
 */
export const emailOtpStartSchema = z.object({
  email: normalizedEmailSchema,
  captchaToken: captchaTokenSchema,
  locale: emailOtpLocaleSchema,
});
export type EmailOtpStartValues = z.infer<typeof emailOtpStartSchema>;

// The code is the authentication proof; the separately explicit, prechecked
// legal acknowledgement authorizes recording the current immutable receipt
// only after that proof succeeds. It is never persisted in browser storage or
// inferred from an old UI mode.
export const emailOtpVerifySchema = z.object({
  email: normalizedEmailSchema,
  code: z.string().check(z.regex(/^\d{6}$/)),
  locale: emailOtpLocaleSchema,
  legalAccepted: z.literal(true),
});
export type EmailOtpVerifyValues = z.infer<typeof emailOtpVerifySchema>;
