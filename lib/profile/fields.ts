import { isPhoneCountryCode } from '@/lib/phone/country-codes';
import type { PhoneInputValue } from '@/lib/phone/countries';

/** The four columns an administrator confirms on a person's card. */
export type ProfileIdentityValues = Readonly<{
  name: string;
  surname: string;
  job: string;
  organization: string;
}>;

/**
 * Education is printed in the certificate and in the protocol, so the person
 * fills it in themselves, for every course, not only for the ones that need it.
 */
export type ProfileValues = ProfileIdentityValues & Readonly<{ education: string }>;

export type ProfileField = keyof ProfileValues;

export type ProfileSubmissionValues = ProfileValues &
  Readonly<{
    phone: PhoneInputValue;
  }>;

export type ProfileSubmissionField = ProfileField | 'phone';

export type ProfileValidationError = Readonly<
  | { code: 'REQUIRED' }
  | { code: 'CONTROL_CHARACTERS' }
  | { code: 'NAME_SCRIPT' }
  | { code: 'TOO_LONG'; maxLength: number }
  | { code: 'PHONE_COUNTRY_REQUIRED' }
  | { code: 'PHONE_INVALID' }
>;

export type ApprovedIdentity = ProfileIdentityValues &
  Readonly<{
    version: number;
    verifiedAt: string;
    verifiedBy: string | null;
  }>;

export type ProfileIdentityState = 'pending' | 'verified' | 'changed' | 'revoked';

export const PROFILE_FIELD_LIMITS = {
  name: 80,
  surname: 80,
  job: 160,
  organization: 160,
  education: 200,
} as const satisfies Record<ProfileField, number>;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * A name reaches a printed certificate and a printed protocol, where the
 * owner's own protocols spell Chinese participants in Latin letters — Chen
 * Binbin, Li Haijian. Letters are therefore limited to Latin and Cyrillic;
 * Cyrillic because Kazakh names carry ә, ғ, қ, ң, ө, ұ, ү, һ, і. Han, kana and
 * emoji are refused. A job title and a company stay unrestricted: a real
 * company name is written in Russian.
 */
export const PERSON_NAME_PATTERN =
  /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Mn}\p{Mc}0-9 '’.-]+$/u;
const PERSON_NAME_LETTER = /[\p{Script=Latin}\p{Script=Cyrillic}]/u;
const PERSON_NAME_FIELDS: readonly ProfileField[] = ['name', 'surname'];

export function isPersonName(value: string) {
  return PERSON_NAME_PATTERN.test(value) && PERSON_NAME_LETTER.test(value);
}

export function normalizeProfileText(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function profileFieldError(field: ProfileField, value: string) {
  const normalized = normalizeProfileText(value);
  if (!normalized) return { code: 'REQUIRED' } as const;
  if (CONTROL_CHARACTERS.test(normalized)) return { code: 'CONTROL_CHARACTERS' } as const;
  if (normalized.length > PROFILE_FIELD_LIMITS[field]) {
    return { code: 'TOO_LONG', maxLength: PROFILE_FIELD_LIMITS[field] } as const;
  }
  if (PERSON_NAME_FIELDS.includes(field) && !isPersonName(normalized)) {
    return { code: 'NAME_SCRIPT' } as const;
  }
  return null;
}

export function validateProfileValues(values: ProfileValues) {
  const errors: Partial<Record<ProfileField, ProfileValidationError>> = {};
  for (const field of Object.keys(PROFILE_FIELD_LIMITS) as ProfileField[]) {
    const error = profileFieldError(field, values[field]);
    if (error) errors[field] = error;
  }
  return errors;
}

export function normalizeProfileValues(values: ProfileValues): ProfileValues {
  return {
    name: normalizeProfileText(values.name),
    surname: normalizeProfileText(values.surname),
    job: normalizeProfileText(values.job),
    organization: normalizeProfileText(values.organization),
    education: normalizeProfileText(values.education),
  };
}

export function normalizeProfileSubmissionValues(
  values: ProfileSubmissionValues,
): ProfileSubmissionValues {
  return {
    ...normalizeProfileValues(values),
    phone: {
      countryIso2: values.phone.countryIso2,
      nationalNumber: values.phone.nationalNumber.trim(),
    },
  };
}

/**
 * Everyone who registers leaves a phone number except a Chinese account. The
 * locale stands for the kind of account here: the database refuses the
 * Chinese locale to any other account and every other locale to a Chinese one
 * (`private.assert_locale_matches_auth_realm`).
 */
export function phoneRequiredForLocale(locale: string) {
  return locale !== 'zh';
}

export function validateProfileSubmissionValues(
  values: ProfileSubmissionValues,
  { phoneRequired = true }: { phoneRequired?: boolean } = {},
) {
  const errors: Partial<Record<ProfileSubmissionField, ProfileValidationError>> =
    validateProfileValues(values);
  const nationalNumber = values.phone.nationalNumber.trim();
  if (!nationalNumber) {
    if (phoneRequired) errors.phone = { code: 'PHONE_INVALID' };
    return errors;
  }
  if (!isPhoneCountryCode(values.phone.countryIso2)) {
    errors.phone = { code: 'PHONE_COUNTRY_REQUIRED' };
  } else if (nationalNumber.length > 64 || !/[0-9]/u.test(nationalNumber)) {
    errors.phone = { code: 'PHONE_INVALID' };
  }
  return errors;
}
