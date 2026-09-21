// No imports: the admin issuance panel is measured against a bundle budget,
// and `lib/profile/fields` pulls in the phone library.

/**
 * The protocol's «Образование» column holds a level, never a school: the
 * training centre's paper forms read «высшее», «среднее специальное». The value
 * is stored and printed in Russian whatever the interface language; only the
 * label in the picker is translated. The database keeps the same list
 * (`private.education_level`).
 */
export const EDUCATION_LEVELS = [
  'Высшее',
  'Неоконченное высшее',
  'Среднее специальное',
  'Среднее',
] as const;

export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const EDUCATION_LEVEL_KEYS = {
  Высшее: 'higher',
  'Неоконченное высшее': 'incompleteHigher',
  'Среднее специальное': 'vocational',
  Среднее: 'secondary',
} as const satisfies Record<EducationLevel, string>;

export function isEducationLevel(value: string): value is EducationLevel {
  return (EDUCATION_LEVELS as readonly string[]).includes(value);
}

/**
 * The level an older free-text answer already names, so a person who wrote
 * «высшее техническое» is not asked again. A school's name says nothing about
 * the level and gives null: the person picks one.
 */
export function educationLevel(value: string | null | undefined): EducationLevel | null {
  const text = (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
  if (!text) return null;
  const exact = EDUCATION_LEVELS.find((level) => level.toLocaleLowerCase('ru-RU') === text);
  if (exact) return exact;
  if (/(неоконч|незаконч|неполн)[^,;]*высш/u.test(text)) return 'Неоконченное высшее';
  if (/высш/u.test(text)) return 'Высшее';
  if (/(средн[^,;]*(спец|проф|техн)|колледж|техникум|училищ)/u.test(text))
    return 'Среднее специальное';
  if (/средн/u.test(text)) return 'Среднее';
  return null;
}
