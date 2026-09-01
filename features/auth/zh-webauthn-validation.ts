import { z } from 'zod';
import { profileSubmissionSchema } from '@/lib/validation/profile';

const base64url = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum).regex(/^[A-Za-z0-9_-]+$/u);

const authenticatorTransportSchema = z.enum([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

export const zhRegistrationProfileSchema = profileSubmissionSchema.extend({
  legalAccepted: z.literal(true),
  avatar: z
    .object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      bytes: z.number().int().min(1).max(100 * 1024),
    })
    .strict(),
});

export const zhRegistrationOptionsSchema = zhRegistrationProfileSchema.strict();

export const webAuthnRegistrationResponseSchema = z
  .object({
    id: base64url(16, 1024),
    rawId: base64url(16, 1024),
    response: z
      .object({
        clientDataJSON: base64url(16, 16 * 1024),
        attestationObject: base64url(32, 256 * 1024),
        authenticatorData: base64url(16, 16 * 1024).optional(),
        transports: z.array(authenticatorTransportSchema).max(7).optional(),
        publicKeyAlgorithm: z.number().int().min(-65536).max(65536).optional(),
        publicKey: base64url(16, 16 * 1024).optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['cross-platform', 'platform']).nullable().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    type: z.literal('public-key'),
  })
  .strict();

export const zhRegistrationVerifySchema = zhRegistrationProfileSchema
  .extend({
    operationId: z.string().uuid(),
    avatarPayload: z
      .object({
        mimeType: z.enum(['image/webp', 'image/jpeg']),
        base64url: base64url(1, 140 * 1024),
      })
      .strict(),
    response: webAuthnRegistrationResponseSchema,
  })
  .strict();

export const zhAuthenticationOptionsSchema = z.object({}).strict();

export const webAuthnAuthenticationResponseSchema = z
  .object({
    id: base64url(16, 1024),
    rawId: base64url(16, 1024),
    response: z
      .object({
        clientDataJSON: base64url(16, 16 * 1024),
        authenticatorData: base64url(16, 16 * 1024),
        signature: base64url(16, 16 * 1024),
        userHandle: base64url(43, 1024).optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['cross-platform', 'platform']).nullable().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    type: z.literal('public-key'),
  })
  .strict();

export const zhAuthenticationVerifySchema = z
  .object({
    requestId: z.string().uuid(),
    response: webAuthnAuthenticationResponseSchema,
  })
  .strict();

export const zhRecoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^SHR1[.][0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.][A-Za-z0-9_-]{43}$/iu);

export const zhRecoveryRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('options'),
      recoveryCode: zhRecoveryCodeSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('verify'),
      requestId: z.string().uuid(),
      recoveryCode: zhRecoveryCodeSchema,
      response: webAuthnRegistrationResponseSchema,
    })
    .strict(),
]);

export const zhAdminCredentialResetSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)),
  })
  .strict();

export type ZhRegistrationProfile = z.infer<typeof zhRegistrationProfileSchema>;
export type ZhRegistrationVerifyRequest = z.infer<typeof zhRegistrationVerifySchema>;
export type ZhAuthenticationVerifyRequest = z.infer<typeof zhAuthenticationVerifySchema>;
export type ZhRecoveryRequest = z.infer<typeof zhRecoveryRequestSchema>;
