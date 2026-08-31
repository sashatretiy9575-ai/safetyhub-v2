import { z } from 'zod';

const verifiedField = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);

export const verifyIdentitySchema = z.object({
  action: z.literal('verify'),
  name: verifiedField(2, 60),
  surname: verifiedField(2, 60),
  job: verifiedField(2, 120),
  organization: verifiedField(2, 180),
});

export const revokeIdentitySchema = z.object({
  action: z.literal('revoke'),
  reason: z.string().trim().min(2).max(500),
});

export const identityActionSchema = z.discriminatedUnion('action', [
  verifyIdentitySchema,
  revokeIdentitySchema,
]);

export const identityUserIdSchema = z.string().uuid();
