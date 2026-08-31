const SCRIPT_ESCAPE_CHARACTERS: Readonly<Record<string, string>> = Object.freeze({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});

/**
 * Serializes structured data without allowing a string value to terminate the
 * surrounding script element. JSON remains byte-for-byte reversible through
 * JSON.parse; only characters that are dangerous in an HTML script context are
 * represented with JSON unicode escapes.
 */
export function serializeJsonForScript(value: object | object[]): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => SCRIPT_ESCAPE_CHARACTERS[character]!,
  );
}
