/**
 * Accept one byte-for-byte canonical query serialization.
 *
 * Parsing and comparing key/value pairs is insufficient for immutable public
 * assets because reordered, duplicated, or alternatively encoded parameters
 * still create distinct cache keys. Call this before any database, Storage, or
 * upstream work.
 */
export function hasExactCanonicalSearch(requestUrl: string, expectedSearch: string) {
  if (expectedSearch !== '' && !expectedSearch.startsWith('?')) {
    throw new Error('CANONICAL_SEARCH_INVALID');
  }
  return new URL(requestUrl).search === expectedSearch;
}

const canonicalUuidPathSegment = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Accept one byte-for-byte lowercase UUID pathname.
 *
 * UUID parsers commonly accept uppercase and percent-encoded aliases. Those
 * aliases address the same PostgreSQL UUID while producing distinct CDN cache
 * keys, so immutable routes must reject them before database or Storage work.
 */
export function hasExactCanonicalUuidPath(
  requestUrl: string,
  routePrefix: string,
  decodedUuid: string,
) {
  if (!routePrefix.startsWith('/') || routePrefix.endsWith('/')) {
    throw new Error('CANONICAL_PATH_PREFIX_INVALID');
  }
  if (!canonicalUuidPathSegment.test(decodedUuid)) return false;
  return new URL(requestUrl).pathname === `${routePrefix}/${decodedUuid}`;
}
