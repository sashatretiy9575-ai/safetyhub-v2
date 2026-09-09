// Written with explicit escapes: a literal control-character class in the
// source is invisible in review and silently degrades to a two-character
// range if anything reformats the file.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const SOURCE_URL_MAX_CHARACTERS = 2_048;

/**
 * One definition of `a link to a source`, shared by article blocks and by the
 * jurisdiction metadata of articles and courses. The two used to disagree: a
 * strict predicate guarded the block editor while metadata was checked with
 * a bare `https://` prefix test, which accepts `https://user:pass@host` and a
 * URL padded with control characters.
 *
 * Rejecting a backslash matters: browsers normalize it to `/`, so
 * `https:/\\evil.example` reaches a different origin than the string reads.
 */
export function isSafeSourceUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > SOURCE_URL_MAX_CHARACTERS ||
    CONTROL_CHARACTERS.test(value) ||
    value.includes('\\')
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}
