'use client';

import { useRef } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { PhoneCountryOption, PhoneInputValue } from '@/lib/phone/countries';

export type PhoneFieldValue = PhoneInputValue;

export function PhoneInput({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  disabled = false,
  optional = false,
  countryOptions,
}: {
  id: string;
  value: PhoneFieldValue;
  onChange: (value: PhoneFieldValue) => void;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  /** A Chinese account may leave the number out; the placeholder says so. */
  optional?: boolean;
  countryOptions: readonly PhoneCountryOption[];
}) {
  const t = useTranslations('Profile');
  // `libphonenumber-js/min` carries the metadata for every country — 39 KiB
  // gzip — and was imported statically into three private pages purely to add
  // spaces while typing. It now loads on the first interaction with the field;
  // until it resolves the value is shown unformatted, which is still correct.
  const formatterRef = useRef<typeof import('libphonenumber-js/min') | null>(null);
  const callingCode =
    countryOptions.find((option) => option.countryIso2 === value.countryIso2)?.callingCode ?? '';

  const ensureFormatter = () => {
    if (formatterRef.current) return;
    void import('libphonenumber-js/min').then((module) => {
      formatterRef.current = module;
    });
  };

  const formatNationalNumber = (country: CountryCode, next: string) => {
    const digits = next.replace(/[^\d+]/gu, '');
    const formatter = formatterRef.current;
    return formatter ? new formatter.AsYouType(country).input(digits) : digits;
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <label className="sr-only" htmlFor={`${id}-country`}>
        {t('phoneCountry')}
      </label>
      <Select
        id={`${id}-country`}
        value={value.countryIso2}
        disabled={disabled}
        onFocus={ensureFormatter}
        onPointerEnter={ensureFormatter}
        onChange={(event) => {
          const countryIso2 = event.target.value as CountryCode;
          onChange({
            countryIso2,
            nationalNumber: formatNationalNumber(countryIso2, value.nationalNumber),
          });
        }}
      >
        {countryOptions.map((option) => (
          <option key={option.countryIso2} value={option.countryIso2}>
            {option.flag} {option.label} ({option.callingCode})
          </option>
        ))}
      </Select>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        onFocus={ensureFormatter}
        onPointerEnter={ensureFormatter}
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
        placeholder={
          optional
            ? `${t('phonePlaceholder', { code: callingCode })} ${t('optional')}`
            : t('phonePlaceholder', { code: callingCode })
        }
        required={!optional}
      />
    </div>
  );
}
