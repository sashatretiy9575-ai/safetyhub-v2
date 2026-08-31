import { z } from 'zod';

export const PASSWORD_MIN_CHARACTERS = 12;
export const PASSWORD_MAX_CHARACTERS = 72;

export const strongPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_CHARACTERS)
  .max(PASSWORD_MAX_CHARACTERS)
  // Supabase Auth hashes passwords with a byte-bounded algorithm. Reject a
  // multi-byte value that looks short in the UI but would cross that boundary.
  .refine((value) => new TextEncoder().encode(value).byteLength <= PASSWORD_MAX_CHARACTERS, {
    message: 'PASSWORD_BYTE_LENGTH_EXCEEDED',
  })
  .regex(/[a-z]/u, 'PASSWORD_LOWERCASE_REQUIRED')
  .regex(/[A-Z]/u, 'PASSWORD_UPPERCASE_REQUIRED')
  .regex(/[0-9]/u, 'PASSWORD_DIGIT_REQUIRED');

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1000),
  captchaToken: z.string().min(1).max(4096).optional(),
});
export type SignInValues = z.infer<typeof signInSchema>;

export const signUpSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: strongPasswordSchema,
    passwordConfirm: z.string().max(PASSWORD_MAX_CHARACTERS),
    legalAccepted: z.literal(true),
    captchaToken: z.string().min(1).max(4096).optional(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: 'passwordsMismatch',
    path: ['passwordConfirm'],
  });
export type SignUpValues = z.infer<typeof signUpSchema>;

const normalizedEmailSchema = z.string().trim().toLowerCase().email().max(254);
const captchaTokenSchema = z.string().min(1).max(4096).optional();

/**
 * Passwordless email entry point. `register` intentionally accepts the same
 * email as an existing account: the server returns a neutral result and never
 * exposes whether an address is already registered.
 */
export const emailOtpStartSchema = z
  .object({
    email: normalizedEmailSchema,
    intent: z.enum(['login', 'register']),
    captchaToken: captchaTokenSchema,
  });
export type EmailOtpStartValues = z.infer<typeof emailOtpStartSchema>;

// Verification deliberately receives only the proof supplied by the Auth
// provider. UI mode and legal consent are not properties of a code and must
// never be inferred from browser-controlled values at this boundary.
export const emailOtpVerifySchema = z.object({
  email: normalizedEmailSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type EmailOtpVerifyValues = z.infer<typeof emailOtpVerifySchema>;

export const resetSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  captchaToken: z.string().min(1).optional(),
});
export type ResetValues = z.infer<typeof resetSchema>;

export const updatePasswordSchema = z
  .object({
    password: strongPasswordSchema,
    passwordConfirm: z.string().max(PASSWORD_MAX_CHARACTERS),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: 'passwordsMismatch',
    path: ['passwordConfirm'],
  });
export type UpdatePasswordValues = z.infer<typeof updatePasswordSchema>;

const newPasswordFields = {
  password: strongPasswordSchema,
  passwordConfirm: z.string().max(PASSWORD_MAX_CHARACTERS),
};

export const passwordChangeRequestSchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('current'),
      currentPassword: z.string().min(1).max(1000),
      captchaToken: z.string().min(1).max(4096).optional(),
      ...newPasswordFields,
    }),
    z.object({
      mode: z.literal('context'),
      contextKind: z.enum(['recovery', 'invite']),
      ...newPasswordFields,
    }),
  ])
  .refine((data) => data.password === data.passwordConfirm, {
    message: 'passwordsMismatch',
    path: ['passwordConfirm'],
  });
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

export const invitePasswordContextSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  accessToken: z.string().min(100).max(16_384),
  refreshToken: z.string().min(20).max(4096),
});

export const recoveryStartSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  captchaToken: z.string().min(1).max(4096).optional(),
});

export const recoveryVerifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().regex(/^\d{6}$/),
});

export const magicLinkSchema = z.object({
  email: z.string().email(),
});
export type MagicLinkValues = z.infer<typeof magicLinkSchema>;
