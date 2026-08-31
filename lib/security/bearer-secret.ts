import { timingSafeEqual } from 'node:crypto';

const DEFAULT_MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_BEARER_CHARACTERS = 512;

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
