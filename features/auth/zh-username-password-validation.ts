import { z } from 'zod';

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const CAPTCHA_TOKEN_MAX_BYTES = 2_048;
export const ZH_PASSWORD_MAX_BYTES = 72;

function hasMaximumUtf8Bytes(value: string, maximum: number) {
  return new TextEncoder().encode(value).byteLength <= maximum;
}

const captchaTokenSchema = z
  .string()
  .min(1)
  .max(CAPTCHA_TOKEN_MAX_BYTES)
  .refine((value) => hasMaximumUtf8Bytes(value, CAPTCHA_TOKEN_MAX_BYTES))
  .optional();

export const zhUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9._-]{2,31}$/u);

export const zhPasswordSchema = z
  .string()
  .min(12)
  .max(ZH_PASSWORD_MAX_BYTES)
  .refine((value) => hasMaximumUtf8Bytes(value, ZH_PASSWORD_MAX_BYTES), {
    message: 'PASSWORD_BYTE_LENGTH_EXCEEDED',
  })
  .refine((value) => !CONTROL_CHARACTERS.test(value))
  .refine((value) => /[a-z]/u.test(value))
  .refine((value) => /[A-Z]/u.test(value))
  .refine((value) => /[0-9]/u.test(value));

const zhPasswordEntrySchema = z
  .string()
  .min(1)
  .max(ZH_PASSWORD_MAX_BYTES)
  .refine((value) => hasMaximumUtf8Bytes(value, ZH_PASSWORD_MAX_BYTES), {
    message: 'PASSWORD_BYTE_LENGTH_EXCEEDED',
  });

const reasonSchema = z
  .string()
  .trim()
  .min(10)
  .max(500)
  .refine((value) => !CONTROL_CHARACTERS.test(value));

export const zhUsernamePasswordLoginSchema = z
  .object({
    username: zhUsernameSchema,
    password: zhPasswordEntrySchema,
    captchaToken: captchaTokenSchema,
  })
  .strict();

export const zhUsernamePasswordRegistrationSchema = z
  .object({
    username: zhUsernameSchema,
    password: zhPasswordSchema,
    passwordConfirmation: zhPasswordEntrySchema,
    legalAccepted: z.literal(true),
    captchaToken: captchaTokenSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.password !== value.passwordConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passwordConfirmation'],
        message: 'PASSWORD_CONFIRMATION_MISMATCH',
      });
    }
  });

const zhAdminPasswordPayload = z
  .object({
    password: zhPasswordSchema,
    passwordConfirmation: zhPasswordEntrySchema,
    reason: reasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.password !== value.passwordConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passwordConfirmation'],
        message: 'PASSWORD_CONFIRMATION_MISMATCH',
      });
    }
  });

export const zhUsernamePasswordResetSchema = zhAdminPasswordPayload;

export const zhUsernamePasswordProvisionSchema = zhAdminPasswordPayload.extend({
  username: zhUsernameSchema,
});

export type ZhUsernamePasswordLogin = z.infer<typeof zhUsernamePasswordLoginSchema>;
export type ZhUsernamePasswordRegistration = z.infer<typeof zhUsernamePasswordRegistrationSchema>;
export type ZhUsernamePasswordReset = z.infer<typeof zhUsernamePasswordResetSchema>;
export type ZhUsernamePasswordProvision = z.infer<typeof zhUsernamePasswordProvisionSchema>;
