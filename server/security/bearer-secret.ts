import { timingSafeEqual } from 'node:crypto';

const DEFAULT_MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_BEARER_CHARACTERS = 512;

/**
 * `.env.example` ships placeholders that are long enough to clear the length
 * check, so an environment copied and never filled in would accept the exact
 * string printed in a public file. The prefix is refused outright.
 */
const PLACEHOLDER_SECRET_PREFIX = 'replace-with-';

export function matchesBearerSecret(
  authorization: string | null,
  configuredSecret: string | undefined,
  minimumBytes = DEFAULT_MINIMUM_SECRET_BYTES,
) {
  const expected = configuredSecret?.trim();
  const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (
    !expected ||
    !provided ||
    expected.startsWith(PLACEHOLDER_SECRET_PREFIX) ||
    provided.length > MAXIMUM_BEARER_CHARACTERS ||
    Buffer.byteLength(expected, 'utf8') < minimumBytes
  ) {
    return false;
  }

  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return (
    expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
  );
}
