import * as z from 'zod';

import {
  isEducationLevel,
  isPersonName,
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

/** Latin or Cyrillic only: the value is printed on a certificate and in a protocol. */
export const personNameField = (maximum: number) =>
  profileField(maximum).refine(isPersonName, 'Имя и фамилию вводите латиницей или кириллицей');

/** One of the four levels the protocol prints; a school's name is refused. */
export const educationField = profileField(PROFILE_FIELD_LIMITS.education).refine(
  isEducationLevel,
  'Выберите уровень образования',
);

/**
 * The administrator's card may send a blank: the database then answers which
 * document needs the education, as it always has. Anything written is a level.
 */
export const optionalEducationField = z
  .string()
  .transform(normalizeProfileText)
  .refine((value) => value === '' || isEducationLevel(value), 'Выберите уровень образования')
  .optional();

export const profileSchema = z.object({
  name: personNameField(PROFILE_FIELD_LIMITS.name),
  surname: personNameField(PROFILE_FIELD_LIMITS.surname),
  job: profileField(PROFILE_FIELD_LIMITS.job),
  organization: profileField(PROFILE_FIELD_LIMITS.organization),
  education: educationField,
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
