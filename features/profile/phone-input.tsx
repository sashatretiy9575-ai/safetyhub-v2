'use client';

import { AsYouType, type CountryCode } from 'libphonenumber-js/min';
import { Input } from '@/components/ui/input';
import {
  countryFlag,
  countryLabel,
  phoneCallingCode,
  phoneCountries,
  type PhoneInputValue,
} from '@/lib/phone';

export type PhoneFieldValue = PhoneInputValue;

export function PhoneInput({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  disabled = false,
}: {
  id: string;
  value: PhoneFieldValue;
  onChange: (value: PhoneFieldValue) => void;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  const countries = phoneCountries();
  const formatNationalNumber = (country: CountryCode, next: string) =>
    new AsYouType(country).input(next.replace(/[^\d+]/gu, ''));

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <label className="sr-only" htmlFor={`${id}-country`}>
        Страна номера
      </label>
      <select
        id={`${id}-country`}
        value={value.countryIso2}
        disabled={disabled}
        onChange={(event) => {
          const countryIso2 = event.target.value as CountryCode;
          onChange({
            countryIso2,
            nationalNumber: formatNationalNumber(countryIso2, value.nationalNumber),
          });
        }}
        className="flex min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] outline-none transition focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
      >
        {countries.map((country) => (
          <option key={country} value={country}>
            {countryFlag(country)} {countryLabel(country)} ({phoneCallingCode(country)})
          </option>
        ))}
      </select>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={value.nationalNumber}
        onChange={(event) =>
          onChange({
            countryIso2: value.countryIso2,
            nationalNumber: formatNationalNumber(value.countryIso2, event.target.value),
          })
        }
        invalid={invalid}
        aria-describedby={describedBy}
        disabled={disabled}
        placeholder={`Номер после ${phoneCallingCode(value.countryIso2)}`}
        required
      />
    </div>
  );
}
