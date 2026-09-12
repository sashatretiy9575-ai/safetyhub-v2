import * as z from 'zod';

import {
  normalizeProfileText,
  PROFILE_FIELD_LIMITS,
  type ProfileValues,
} from '@/lib/profile/fields';

export { normalizeProfileText } from '@/lib/profile/fields';
export type { ProfileValues } from '@/lib/profile/fields';

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * Exported so administrative writes to the same profile columns cannot drift
 * from the participant-facing rules.
 */
export const profileField = (maximum: number) =>
  z
    .string()
    .transform(normalizeProfileText)
    .pipe(
      z
        .string()
        .min(1)
        .max(maximum)
        .refine((value) => !CONTROL_CHARACTERS.test(value), 'Недопустимые служебные символы'),
    );

export const profileSchema = z.object({
  name: profileField(PROFILE_FIELD_LIMITS.name),
  surname: profileField(PROFILE_FIELD_LIMITS.surname),
  job: profileField(PROFILE_FIELD_LIMITS.job),
  organization: profileField(PROFILE_FIELD_LIMITS.organization),
});
type SchemaProfileValues = z.infer<typeof profileSchema>;
const _profileTypeCheck: ProfileValues = {} as SchemaProfileValues;
void _profileTypeCheck;

// An empty national number passes the schema because a Chinese account may
// register without a phone. The routes require one from everyone else
// (phoneRequiredForLocale), and a filled number still has to be a real one.
export const profileSubmissionSchema = profileSchema.extend({
  phone: z.object({
    countryIso2: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
    nationalNumber: z.string().trim().max(64),
  }),
});

export const onboardingProfileSchema = profileSubmissionSchema;
export type OnboardingProfileValues = z.infer<typeof onboardingProfileSchema>;
