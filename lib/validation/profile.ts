import { z } from 'zod';

import {
  normalizeProfileText,
  PROFILE_FIELD_LIMITS,
  type ProfileValues,
} from '@/features/profile/fields';

export { normalizeProfileText } from '@/features/profile/fields';
export type { ProfileValues } from '@/features/profile/fields';

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const profileField = (maximum: number) =>
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

export const onboardingProfileSchema = profileSchema;
export type OnboardingProfileValues = ProfileValues;
