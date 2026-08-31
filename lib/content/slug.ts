export const CONTENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONTENT_SLUG_MAX_CHARACTERS = 120;

export function isContentSlug(value: string): boolean {
  return value.length > 0 && value.length <= CONTENT_SLUG_MAX_CHARACTERS && CONTENT_SLUG_PATTERN.test(value);
}
