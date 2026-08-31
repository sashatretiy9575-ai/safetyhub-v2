import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MINIMUM_SECRET_CHARACTERS = 32;

/** `v1.<certificate UUID>.<base64url HMAC-SHA256>`. */
export const CERTIFICATE_VERIFICATION_TOKEN_PATTERN = new RegExp(
  `^${TOKEN_VERSION}\\.(${UUID_SOURCE})\\.([A-Za-z0-9_-]{43})$`,
  'i',
);

type VerificationEnvironment = Record<string, string | undefined>;

function validatedSecret(value: string, variableName: string) {
  if (
    Array.from(value).length < MINIMUM_SECRET_CHARACTERS ||
    Buffer.byteLength(value, 'utf8') < MINIMUM_SECRET_CHARACTERS
  ) {
    throw new Error(`${variableName}_TOO_SHORT`);
  }
  return value;
}

function verificationSecrets(environment: VerificationEnvironment = process.env) {
  const current = environment.CERTIFICATE_VERIFICATION_SECRET?.trim();
  if (!current) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('CERTIFICATE_VERIFICATION_SECRET_MISSING');
    }
    return ['safetyhub-local-verification-secret-change-before-production'];
  }
  const validCurrent = validatedSecret(current, 'CERTIFICATE_VERIFICATION_SECRET');
  const previous = environment.CERTIFICATE_VERIFICATION_PREVIOUS_SECRET?.trim();
  const validPrevious = previous
    ? validatedSecret(previous, 'CERTIFICATE_VERIFICATION_PREVIOUS_SECRET')
    : null;
  return validPrevious && validPrevious !== validCurrent
    ? [validCurrent, validPrevious]
    : [validCurrent];
}

function message(certificateId: string) {
  return `${TOKEN_VERSION}:${certificateId.toLowerCase()}`;
}

function signature(certificateId: string, secret: string) {
  return createHmac('sha256', secret).update(message(certificateId), 'utf8').digest('base64url');
}

export function isCertificateVerificationToken(value: string): boolean {
  return CERTIFICATE_VERIFICATION_TOKEN_PATTERN.test(value);
}

export function createCertificateVerificationToken(
  certificateId: string,
  environment: VerificationEnvironment = process.env,
) {
  if (!new RegExp(`^${UUID_SOURCE}$`, 'i').test(certificateId)) {
    throw new Error('INVALID_CERTIFICATE_ID');
  }
  const [current] = verificationSecrets(environment);
  return `${TOKEN_VERSION}.${certificateId.toLowerCase()}.${signature(certificateId, current!)}`;
}

export function verifyCertificateVerificationToken(
  token: string,
  environment: VerificationEnvironment = process.env,
): string | null {
  const match = CERTIFICATE_VERIFICATION_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const certificateId = match[1]!.toLowerCase();
  const provided = Buffer.from(match[2]!, 'base64url');
  let valid = false;
  for (const secret of verificationSecrets(environment)) {
    const expected = Buffer.from(signature(certificateId, secret), 'base64url');
    valid = (provided.length === expected.length && timingSafeEqual(provided, expected)) || valid;
  }
  return valid ? certificateId : null;
}

export function certificateVerificationUrl(siteUrl: string, token: string): string {
  if (!isCertificateVerificationToken(token)) {
    throw new Error('INVALID_CERTIFICATE_VERIFICATION_TOKEN');
  }
  return `${siteUrl.replace(/\/$/, '')}/verify/${token}`;
}
