import * as z from 'zod/mini';

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const CAPTCHA_TOKEN_MAX_BYTES = 2_048;
export const ZH_PASSWORD_MAX_BYTES = 72;

function hasMaximumUtf8Bytes(value: string, maximum: number) {
  return new TextEncoder().encode(value).byteLength <= maximum;
}

const captchaTokenSchema = z.optional(
  z
    .string()
    .check(
      z.minLength(1),
      z.maxLength(CAPTCHA_TOKEN_MAX_BYTES),
      z.refine((value) => hasMaximumUtf8Bytes(value, CAPTCHA_TOKEN_MAX_BYTES)),
    ),
);

export const zhUsernameSchema = z
  .string()
  .check(z.trim(), z.toLowerCase(), z.regex(/^[a-z][a-z0-9._-]{2,31}$/u));

export const zhPasswordSchema = z
  .string()
  .check(
    z.minLength(12),
    z.maxLength(ZH_PASSWORD_MAX_BYTES),
    z.refine((value) => hasMaximumUtf8Bytes(value, ZH_PASSWORD_MAX_BYTES), {
      message: 'PASSWORD_BYTE_LENGTH_EXCEEDED',
    }),
    z.refine((value) => !CONTROL_CHARACTERS.test(value)),
    z.refine((value) => /[a-z]/u.test(value)),
    z.refine((value) => /[A-Z]/u.test(value)),
    z.refine((value) => /[0-9]/u.test(value)),
  );

const zhPasswordEntrySchema = z
  .string()
  .check(
    z.minLength(1),
    z.maxLength(ZH_PASSWORD_MAX_BYTES),
    z.refine((value) => hasMaximumUtf8Bytes(value, ZH_PASSWORD_MAX_BYTES), {
      message: 'PASSWORD_BYTE_LENGTH_EXCEEDED',
    }),
  );

const reasonSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(10),
    z.maxLength(500),
    z.refine((value) => !CONTROL_CHARACTERS.test(value)),
  );

const passwordConfirmationMatches = z.superRefine(
  (value: { password: string; passwordConfirmation: string }, context) => {
    if (value.password !== value.passwordConfirmation) {
      context.addIssue({
        code: 'custom',
        path: ['passwordConfirmation'],
        message: 'PASSWORD_CONFIRMATION_MISMATCH',
      });
    }
  },
);

export const zhUsernamePasswordLoginSchema = z.strictObject({
  username: zhUsernameSchema,
  password: zhPasswordEntrySchema,
  captchaToken: captchaTokenSchema,
});

export const zhUsernamePasswordRegistrationSchema = z
  .strictObject({
    username: zhUsernameSchema,
    password: zhPasswordSchema,
    passwordConfirmation: zhPasswordEntrySchema,
    legalAccepted: z.literal(true),
    captchaToken: captchaTokenSchema,
  })
  .check(passwordConfirmationMatches);

const zhAdminPasswordPayload = z
  .strictObject({
    password: zhPasswordSchema,
    passwordConfirmation: zhPasswordEntrySchema,
    reason: reasonSchema,
  })
  .check(passwordConfirmationMatches);

export const zhUsernamePasswordResetSchema = zhAdminPasswordPayload;

export const zhUsernamePasswordProvisionSchema = z.extend(zhAdminPasswordPayload, {
  username: zhUsernameSchema,
});

export type ZhUsernamePasswordLogin = z.infer<typeof zhUsernamePasswordLoginSchema>;
export type ZhUsernamePasswordRegistration = z.infer<typeof zhUsernamePasswordRegistrationSchema>;
export type ZhUsernamePasswordReset = z.infer<typeof zhUsernamePasswordResetSchema>;
export type ZhUsernamePasswordProvision = z.infer<typeof zhUsernamePasswordProvisionSchema>;
