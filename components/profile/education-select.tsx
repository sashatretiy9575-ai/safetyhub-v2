'use client';

import { forwardRef } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { EDUCATION_LEVEL_KEYS, EDUCATION_LEVELS, educationLevel } from '@/lib/profile/education';

/**
 * The four levels the protocol prints. An older free-text answer that names a
 * level is shown as that level; a school's name shows nothing chosen, so the
 * person picks one before saving.
 */
export const EducationSelect = forwardRef<
  HTMLSelectElement,
  {
    id: string;
    value: string;
    onChange: (value: string) => void;
    invalid?: boolean;
    'aria-describedby'?: string;
  }
>(function EducationSelect({ id, value, onChange, invalid, ...rest }, ref) {
  const t = useTranslations('Profile');
  return (
    <Select
      ref={ref}
      id={id}
      value={educationLevel(value) ?? ''}
      onChange={(event) => onChange(event.target.value)}
      invalid={invalid}
      aria-describedby={rest['aria-describedby']}
      required
    >
      <option value="" disabled>
        {t('educationPlaceholder')}
      </option>
      {EDUCATION_LEVELS.map((level) => (
        <option key={level} value={level}>
          {t(`educationLevels.${EDUCATION_LEVEL_KEYS[level]}`)}
        </option>
      ))}
    </Select>
  );
});
