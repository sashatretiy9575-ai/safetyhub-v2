import 'server-only';

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const RECOVERY_PREFIX = 'SHR1';
const RECOVERY_CODE_PATTERN =
  /^SHR1[.]([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[.]([A-Za-z0-9_-]{43})$/iu;

function recoveryPepper() {
  const value = process.env.ZH_RECOVERY_PEPPER;
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('ZH_RECOVERY_PEPPER_REQUIRED');
  }
  return value;
}

export function sha256Hex(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

export function bytesToBase64url(value: Uint8Array) {
  return Buffer.from(value).toString('base64url');
}

export function base64urlToBytes(value: string) {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('BASE64URL_INVALID');
  return new Uint8Array(bytes);
}

export function registrationPayloadHash(value: Readonly<{
  name: string;
  surname: string;
  job: string;
  organization: string;
  phoneCountryIso2: string;
  phoneE164: string;
  avatarSha256: string;
  avatarBytes: number;
  privacyVersion: string;
  privacyBodyRevision: string;
  termsVersion: string;
  termsBodyRevision: string;
}>) {
  return sha256Hex(JSON.stringify(value));
}

function recoveryDigest(code: string, salt: string) {
  return createHmac('sha256', recoveryPepper())
    .update(`safetyhub:zh-recovery:v1:${salt}:${code}`, 'utf8')
    .digest('hex');
}

export type RecoveryMaterial = Readonly<{
  locator: string;
  salt: string;
  digest: string;
  code: string;
}>;

export function createRecoveryMaterial(): RecoveryMaterial {
  const locator = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const code = `${RECOVERY_PREFIX}.${locator}.${secret}`;
  const salt = randomBytes(16).toString('hex');
  return { locator, salt, digest: recoveryDigest(code, salt), code };
}

/**
 * An admin reset must be idempotent even if the committed response is lost.
 * Derive the one-time secret and salt from the server pepper plus the exact
 * actor/target/idempotency tuple; PostgreSQL stores only its final digest.
 */
export function deriveAdminReenrollmentMaterial(input: Readonly<{
  actorId: string;
  targetUserId: string;
  idempotencyKey: string;
}>): RecoveryMaterial {
  const context = `${input.actorId}:${input.targetUserId}:${input.idempotencyKey}`;
  const secret = createHmac('sha256', recoveryPepper())
    .update(`safetyhub:zh-admin-reenrollment-secret:v1:${context}`, 'utf8')
    .digest('base64url');
  const salt = createHmac('sha256', recoveryPepper())
    .update(`safetyhub:zh-admin-reenrollment-salt:v1:${context}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const locator = input.idempotencyKey;
  const code = `${RECOVERY_PREFIX}.${locator}.${secret}`;
  return { locator, salt, digest: recoveryDigest(code, salt), code };
}

export function parseRecoveryCode(value: string) {
  const match = value.trim().match(RECOVERY_CODE_PATTERN);
  if (!match?.[1]) return null;
  return { code: value.trim(), locator: match[1].toLowerCase() };
}

export function recoveryCodeMatches(code: string, salt: string, expectedDigest: string) {
  if (!/^[0-9a-f]{32}$/u.test(salt) || !/^[0-9a-f]{64}$/u.test(expectedDigest)) {
    return false;
  }
  const observed = Buffer.from(recoveryDigest(code, salt), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return observed.length === expected.length && timingSafeEqual(observed, expected);
}
