import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { isPhoneCountryCode } from './phone.ts';

export type UserPhoneInput = Readonly<{
  countryIso2: string;
  nationalNumber: string;
}>;

export type NormalizedUserPhone = Readonly<{
  countryIso2: CountryCode;
  phoneE164: string;
}>;

/**
 * Normalizes user-entered national notation at a trusted server boundary.
 * The selected country must agree with the parsed number so a shared calling
 * code such as +7 cannot silently change the user's stated country.
 */
export function normalizeUserPhone(input: UserPhoneInput): NormalizedUserPhone | null {
  const countryIso2 = input.countryIso2.trim().toUpperCase();
  if (!isPhoneCountryCode(countryIso2)) return null;
  const nationalNumber = input.nationalNumber.trim();
  if (!nationalNumber || nationalNumber.length > 64) return null;
  const parsed = parsePhoneNumberFromString(nationalNumber, countryIso2);
  if (!parsed || !parsed.isValid() || parsed.country !== countryIso2) return null;
  return { countryIso2, phoneE164: parsed.number };
}
