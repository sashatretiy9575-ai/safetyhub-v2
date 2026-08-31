import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

export const PRIORITY_PHONE_COUNTRIES = ['KZ', 'RU', 'CN'] as const satisfies readonly CountryCode[];

export type PhoneInputValue = Readonly<{
  countryIso2: CountryCode;
  nationalNumber: string;
}>;

export function isPhoneCountryCode(value: string): value is CountryCode {
  return (getCountries() as readonly string[]).includes(value);
}

export function countryFlag(country: CountryCode) {
  return String.fromCodePoint(...[...country].map((letter) => 0x1f1a5 + letter.charCodeAt(0)));
}

export function countryLabel(country: CountryCode, locale = 'ru') {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? country;
  } catch {
    return country;
  }
}

export function phoneCountries(locale = 'ru'): CountryCode[] {
  const priority = PRIORITY_PHONE_COUNTRIES.filter((country) => isPhoneCountryCode(country));
  const rest = getCountries()
    .filter((country) => !priority.includes(country as (typeof priority)[number]))
    .sort((left, right) => countryLabel(left, locale).localeCompare(countryLabel(right, locale), locale));
  return [...priority, ...rest];
}

export function phoneCallingCode(country: CountryCode) {
  return `+${getCountryCallingCode(country)}`;
}

/** Converts a stored self-contact number back into an editable national form. */
export function phoneInputValueFromE164(
  countryIso2: string | null | undefined,
  phoneE164: string | null | undefined,
): PhoneInputValue {
  const rawCountry = countryIso2 ?? '';
  const country: CountryCode = isPhoneCountryCode(rawCountry) ? rawCountry : 'KZ';
  const parsed = phoneE164 ? parsePhoneNumberFromString(phoneE164) : null;
  return {
    countryIso2: country,
    nationalNumber:
      parsed && parsed.country === country && parsed.isPossible() ? parsed.formatNational() : '',
  };
}
