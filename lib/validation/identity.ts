import * as z from 'zod';
import { PROFILE_FIELD_LIMITS } from '@/features/profile/fields';
import { profileField } from '@/lib/validation/profile';

/**
 * Administrative identity verification writes the same four columns a
 * participant fills in, so it must obey the same rules. It previously used its
 * own bounds — 60/60/120/180 against the database's 80/80/160/160 — and skipped
 * both Unicode normalization and the control-character filter. An `organization`
 * of 161 to 180 characters therefore passed the API, reached the column CHECK,
 * and came back to the operator as an anonymous 400.
 */
export const verifyIdentitySchema = z.object({
  action: z.literal('verify'),
  name: profileField(PROFILE_FIELD_LIMITS.name),
  surname: profileField(PROFILE_FIELD_LIMITS.surname),
  job: profileField(PROFILE_FIELD_LIMITS.job),
  organization: profileField(PROFILE_FIELD_LIMITS.organization),
});

export const revokeIdentitySchema = z.object({
  action: z.literal('revoke'),
  // The database requires a reason of at least three characters; accepting two
  // here produced the same anonymous 400 as an over-long organization.
  reason: z.string().trim().min(3).max(500),
});

export const identityActionSchema = z.discriminatedUnion('action', [
  verifyIdentitySchema,
  revokeIdentitySchema,
]);

export const identityUserIdSchema = z.string().uuid();
