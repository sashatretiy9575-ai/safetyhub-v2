export type ProfileValues = Readonly<{
  name: string;
  surname: string;
  job: string;
  organization: string;
}>;

export type ProfileField = keyof ProfileValues;

export type ApprovedIdentity = ProfileValues &
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
} as const satisfies Record<ProfileField, number>;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function normalizeProfileText(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function profileFieldError(field: ProfileField, value: string) {
  const normalized = normalizeProfileText(value);
  if (!normalized) return 'Заполните поле.';
  if (CONTROL_CHARACTERS.test(normalized)) return 'Удалите недопустимые служебные символы.';
  if (normalized.length > PROFILE_FIELD_LIMITS[field]) {
    return `Не более ${PROFILE_FIELD_LIMITS[field]} символов.`;
  }
  return null;
}

export function validateProfileValues(values: ProfileValues) {
  const errors: Partial<Record<ProfileField, string>> = {};
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
  };
}
