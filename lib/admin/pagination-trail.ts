/**
 * Keyset ("cursor") paging can only move forward: the database RPCs behind the
 * admin lists take the last row of the current page and return the next one.
 * That left every admin list with a one-way "Следующая »" button and no way
 * back — the journal in particular looked as if it did not page at all.
 *
 * The trail keeps the cursor tokens of the pages already visited in the URL, so
 * "‹ Назад" is an ordinary link and the current page number is known without
 * any extra database work. An empty token means "the first page".
 */

export const ADMIN_TRAIL_PARAM = 'trail';

/** Longer trails would bloat the URL without helping anyone; jump to page 1. */
const MAX_TRAIL_LENGTH = 60;
const TRAIL_SEPARATOR = '~';

export function parseAdminTrail(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  return raw
    .split(TRAIL_SEPARATOR)
    .slice(0, MAX_TRAIL_LENGTH)
    .map((token) => {
      try {
        return decodeURIComponent(token);
      } catch {
        return '';
      }
    });
}

export function serializeAdminTrail(trail: readonly string[]): string {
  if (trail.length === 0) return '';
  return trail
    .slice(-MAX_TRAIL_LENGTH)
    .map((token) => encodeURIComponent(token))
    .join(TRAIL_SEPARATOR);
}

export function appendAdminTrail(trail: readonly string[], token: string): string[] {
  return [...trail, token].slice(-MAX_TRAIL_LENGTH);
}
