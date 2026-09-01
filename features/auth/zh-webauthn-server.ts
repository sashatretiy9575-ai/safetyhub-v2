import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createEphemeralAuthClient } from '@/lib/supabase/ephemeral-auth';
import { createClient } from '@/lib/supabase/server';
import { normalizeUserPhone } from '@/lib/phone-server';
import { getCurrentLegalPolicies, type CurrentLegalPolicies } from '@/lib/legal-current';
import { normalizeAvatarImage } from '@/lib/security/avatar-decode';
import { validatedStaticWebpDimensions } from '@/lib/security/avatar-webp';
import { AVATAR_HEIGHT, AVATAR_MAX_BYTES, AVATAR_WIDTH } from '@/lib/avatar-image';
import { requireCapability } from '@/features/auth/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import type { AdminRequestMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import {
  base64urlToBytes,
  bytesToBase64url,
  createRecoveryMaterial,
  deriveAdminReenrollmentMaterial,
  parseRecoveryCode,
  recoveryCodeMatches,
  registrationPayloadHash,
  sha256Hex,
} from '@/features/auth/zh-webauthn-crypto';
import type {
  ZhAuthenticationVerifyRequest,
  ZhRecoveryRequest,
  ZhRegistrationProfile,
  ZhRegistrationVerifyRequest,
} from '@/features/auth/zh-webauthn-validation';
import type { ZhWebAuthnRelyingParty } from '@/features/auth/zh-webauthn-config';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYNTHETIC_EMAIL_PATTERN = /^[0-9a-f]{32}@auth[.]invalid$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const USER_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1024}$/u;
const RECOVERY_FAILURE = 'ZH_RECOVERY_FAILED';
const AUTHENTICATION_FAILURE = 'ZH_AUTHENTICATION_FAILED';
const REGISTRATION_FAILURE = 'ZH_REGISTRATION_FAILED';
const AUTH_UNAVAILABLE = 'ZH_AUTH_UNAVAILABLE';
const AVATAR_BUCKET = 'profile-avatars';

type RpcError = { message: string; code?: string };
type RpcClient = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

type RegistrationOperation = Readonly<{
  operationId: string;
  state:
    | 'prepared'
    | 'auth_created'
    | 'storage_written'
    | 'completed'
    | 'cleanup_required'
    | 'cleanup_claimed'
    | 'cleaned';
  challengeSha256: string;
  requestHash: string;
  userHandle: string;
  syntheticEmail: string;
  authUserId: string | null;
  avatarObjectKey: string | null;
  expiresAt: string;
  consumedAt: string | null;
}>;

type AuthenticationContext = Readonly<{
  requestId: string;
  challengeSha256: string;
  credentialId: string;
  publicKeyBase64: string;
  signatureCounter: number;
  transports: AuthenticatorTransportFuture[];
  userId: string;
  userHandle: string;
}>;

type RecoveryContext = Readonly<{
  locator: string;
  userId: string;
  userHandle: string;
  salt: string;
  digest: string;
  kind: 'self_recovery' | 'admin_reenrollment';
  expiresAt: string | null;
  activeCredentialIds: string[];
}>;

type RecoveryVerificationContext = Omit<RecoveryContext, 'activeCredentialIds'> & {
  requestId: string;
  challengeSha256: string;
};

export class ZhWebAuthnError extends Error {
  constructor(
    public readonly code:
      | typeof REGISTRATION_FAILURE
      | typeof AUTHENTICATION_FAILURE
      | typeof RECOVERY_FAILURE
      | typeof AUTH_UNAVAILABLE,
    public readonly status: 400 | 503,
  ) {
    super(code);
    this.name = 'ZhWebAuthnError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function serviceClient() {
  return createAdminClient() as unknown as RpcClient;
}

async function serviceRpc(name: string, args?: Record<string, unknown>) {
  const response = await serviceClient().rpc(name, args);
  if (response.error) throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  return response.data;
}

function normalizeRegistrationProfile(
  value: ZhRegistrationProfile,
  currentLegal: CurrentLegalPolicies,
) {
  const phone = normalizeUserPhone(value.phone);
  if (!phone) throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  const payload = {
    name: value.name,
    surname: value.surname,
    job: value.job,
    organization: value.organization,
    phoneCountryIso2: phone.countryIso2,
    phoneE164: phone.phoneE164,
    avatarSha256: value.avatar.sha256,
    avatarBytes: value.avatar.bytes,
    privacyVersion: currentLegal.privacy.version,
    privacyBodyRevision: currentLegal.privacy.bodyRevision,
    termsVersion: currentLegal.terms.version,
    termsBodyRevision: currentLegal.terms.bodyRevision,
  } as const;
  return { ...payload, requestHash: registrationPayloadHash(payload) };
}

function parseRegistrationOperation(value: unknown): RegistrationOperation {
  const result = record(value);
  if (
    !result ||
    typeof result.operationId !== 'string' ||
    !UUID_PATTERN.test(result.operationId) ||
    ![
      'prepared',
      'auth_created',
      'storage_written',
      'completed',
      'cleanup_required',
      'cleanup_claimed',
      'cleaned',
    ].includes(String(result.state)) ||
    typeof result.challengeSha256 !== 'string' ||
    !SHA256_PATTERN.test(result.challengeSha256) ||
    typeof result.requestHash !== 'string' ||
    !SHA256_PATTERN.test(result.requestHash) ||
    typeof result.userHandle !== 'string' ||
    !USER_HANDLE_PATTERN.test(result.userHandle) ||
    typeof result.syntheticEmail !== 'string' ||
    !SYNTHETIC_EMAIL_PATTERN.test(result.syntheticEmail) ||
    (result.authUserId !== null &&
      (typeof result.authUserId !== 'string' || !UUID_PATTERN.test(result.authUserId))) ||
    (result.avatarObjectKey !== null && typeof result.avatarObjectKey !== 'string') ||
    !validDate(result.expiresAt) ||
    (result.consumedAt !== null && !validDate(result.consumedAt))
  ) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  return result as RegistrationOperation;
}

async function getRegistrationOperation(operationId: string) {
  const value = await serviceRpc('get_zh_registration_operation', {
    p_operation_id: operationId,
  });
  if (value === null) throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  return parseRegistrationOperation(value);
}

function parseAuthenticationContext(value: unknown): AuthenticationContext {
  const result = record(value);
  const transports = result?.transports;
  if (
    !result ||
    typeof result.requestId !== 'string' ||
    !UUID_PATTERN.test(result.requestId) ||
    typeof result.challengeSha256 !== 'string' ||
    !SHA256_PATTERN.test(result.challengeSha256) ||
    typeof result.credentialId !== 'string' ||
    !CREDENTIAL_ID_PATTERN.test(result.credentialId) ||
    typeof result.publicKeyBase64 !== 'string' ||
    result.publicKeyBase64.length > 8192 ||
    !Number.isSafeInteger(result.signatureCounter) ||
    Number(result.signatureCounter) < 0 ||
    !Array.isArray(transports) ||
    !transports.every((item) =>
      ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(String(item)),
    ) ||
    typeof result.userId !== 'string' ||
    !UUID_PATTERN.test(result.userId) ||
    typeof result.userHandle !== 'string' ||
    !USER_HANDLE_PATTERN.test(result.userHandle)
  ) {
    throw new ZhWebAuthnError(AUTHENTICATION_FAILURE, 400);
  }
  return result as unknown as AuthenticationContext;
}

function parseRecoveryContext(value: unknown): RecoveryContext {
  const result = record(value);
  if (
    !result ||
    typeof result.locator !== 'string' ||
    !UUID_PATTERN.test(result.locator) ||
    typeof result.userId !== 'string' ||
    !UUID_PATTERN.test(result.userId) ||
    typeof result.userHandle !== 'string' ||
    !USER_HANDLE_PATTERN.test(result.userHandle) ||
    typeof result.salt !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(result.salt) ||
    typeof result.digest !== 'string' ||
    !SHA256_PATTERN.test(result.digest) ||
    !['self_recovery', 'admin_reenrollment'].includes(String(result.kind)) ||
    (result.expiresAt !== null && !validDate(result.expiresAt)) ||
    !Array.isArray(result.activeCredentialIds) ||
    !result.activeCredentialIds.every(
      (credentialId) =>
        typeof credentialId === 'string' && CREDENTIAL_ID_PATTERN.test(credentialId),
    )
  ) {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  return result as RecoveryContext;
}

function parseRecoveryVerificationContext(value: unknown): RecoveryVerificationContext {
  const result = record(value);
  if (!result) throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  const base = parseRecoveryContext({ ...result, activeCredentialIds: [] });
  if (
    typeof result.requestId !== 'string' ||
    !UUID_PATTERN.test(result.requestId) ||
    typeof result.challengeSha256 !== 'string' ||
    !SHA256_PATTERN.test(result.challengeSha256)
  ) {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  return { ...base, requestId: result.requestId, challengeSha256: result.challengeSha256 };
}

function challengeMatches(expectedSha256: string) {
  return (challenge: string) => sha256Hex(challenge) === expectedSha256;
}

function sameBase64url(left: string, right: string) {
  try {
    return bytesToBase64url(base64urlToBytes(left)) === bytesToBase64url(base64urlToBytes(right));
  } catch {
    return false;
  }
}

function transports(value: readonly string[] | undefined): AuthenticatorTransportFuture[] {
  const supported = new Set<AuthenticatorTransportFuture>([
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
  ]);
  return [...new Set(value ?? [])].filter((item): item is AuthenticatorTransportFuture =>
    supported.has(item as AuthenticatorTransportFuture),
  );
}

async function issueSyntheticSession(expectedUserId: string, syntheticEmail: string) {
  if (!UUID_PATTERN.test(expectedUserId) || !SYNTHETIC_EMAIL_PATTERN.test(syntheticEmail)) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  const admin = createAdminClient();
  const generated = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: syntheticEmail,
  });
  if (
    generated.error ||
    generated.data.user.id !== expectedUserId ||
    generated.data.properties.verification_type !== 'magiclink' ||
    !generated.data.properties.hashed_token
  ) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }

  const ephemeral = createEphemeralAuthClient();
  const verified = await ephemeral.auth.verifyOtp({
    token_hash: generated.data.properties.hashed_token,
    type: 'magiclink',
  });
  if (verified.error || !verified.data.session || verified.data.user?.id !== expectedUserId) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  const cookieClient = await createClient();
  const persisted = await cookieClient.auth.setSession({
    access_token: verified.data.session.access_token,
    refresh_token: verified.data.session.refresh_token,
  });
  if (persisted.error || persisted.data.user?.id !== expectedUserId || !persisted.data.session) {
    await cookieClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
}

async function normalizeAndBindAvatar(value: ZhRegistrationVerifyRequest) {
  let rawBytes: Uint8Array;
  try {
    rawBytes = base64urlToBytes(value.avatarPayload.base64url);
  } catch {
    throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  }
  if (
    rawBytes.byteLength !== value.avatar.bytes ||
    rawBytes.byteLength > AVATAR_MAX_BYTES ||
    sha256Hex(rawBytes) !== value.avatar.sha256
  ) {
    throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  }
  const normalized = await normalizeAvatarImage(rawBytes, value.avatarPayload.mimeType);
  const dimensions = normalized ? validatedStaticWebpDimensions(normalized) : null;
  if (
    !normalized ||
    normalized.byteLength > AVATAR_MAX_BYTES ||
    dimensions?.width !== AVATAR_WIDTH ||
    dimensions.height !== AVATAR_HEIGHT
  ) {
    throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  }
  return {
    bytes: normalized,
    sha256: createHash('sha256').update(normalized).digest('hex'),
  };
}

async function storageObjectMatches(objectKey: string, bytes: Uint8Array, sha256: string) {
  const admin = createAdminClient();
  const downloaded = await admin.storage
    .from(AVATAR_BUCKET)
    .download(objectKey, {}, { cache: 'no-store' });
  if (downloaded.error || !downloaded.data || downloaded.data.size !== bytes.byteLength) {
    return false;
  }
  const observed = new Uint8Array(await downloaded.data.arrayBuffer());
  return createHash('sha256').update(observed).digest('hex') === sha256;
}

async function persistRegistrationAvatar(
  operationId: string,
  userId: string,
  avatar: Readonly<{ bytes: Uint8Array; sha256: string }>,
) {
  const objectKey = `${userId}/objects/${operationId}.webp`;
  const admin = createAdminClient();
  const uploaded = await admin.storage.from(AVATAR_BUCKET).upload(objectKey, avatar.bytes, {
    contentType: 'image/webp',
    cacheControl: '600',
    upsert: false,
  });
  if (uploaded.error) {
    if (!(await storageObjectMatches(objectKey, avatar.bytes, avatar.sha256))) {
      throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
    }
  } else if (uploaded.data?.path !== objectKey) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  await serviceRpc('mark_zh_registration_storage_written', {
    p_operation_id: operationId,
    p_user_id: userId,
    p_object_key: objectKey,
    p_sha256: avatar.sha256,
    p_bytes: avatar.bytes.byteLength,
  });
  return objectKey;
}

async function compensateRegistration(
  operationId: string,
  userId: string,
  objectKey: string | null,
) {
  try {
    await serviceRpc('mark_zh_registration_cleanup_required', {
      p_operation_id: operationId,
      p_error_code: 'APP_REGISTRATION_FAILED',
    });
    const admin = createAdminClient();
    if (objectKey === `${userId}/objects/${operationId}.webp`) {
      const removed = await admin.storage.from(AVATAR_BUCKET).remove([objectKey]);
      if (removed.error) return;
    }
    const deleted = await admin.auth.admin.deleteUser(userId);
    if (deleted.error && Number(deleted.error.status) !== 404) return;
    await serviceRpc('finish_zh_registration_cleanup', {
      p_operation_id: operationId,
      p_success: true,
      p_error_code: null,
    });
  } catch {
    // Durable cleanup_required state is the recovery mechanism. Never log the
    // synthetic email, credential, Auth response, or avatar object details.
  }
}

export async function reconcileOneZhRegistrationCleanup() {
  try {
    const value = await serviceRpc('claim_zh_registration_cleanup');
    if (value === null) return;
    const cleanup = record(value);
    if (
      !cleanup ||
      typeof cleanup.operationId !== 'string' ||
      !UUID_PATTERN.test(cleanup.operationId) ||
      typeof cleanup.userId !== 'string' ||
      !UUID_PATTERN.test(cleanup.userId) ||
      (cleanup.objectKey !== null &&
        cleanup.objectKey !== `${cleanup.userId}/objects/${cleanup.operationId}.webp`)
    ) {
      return;
    }
    const admin = createAdminClient();
    if (typeof cleanup.objectKey === 'string') {
      const removed = await admin.storage.from(AVATAR_BUCKET).remove([cleanup.objectKey]);
      if (removed.error) throw new Error('STORAGE_DELETE_FAILED');
    }
    const deleted = await admin.auth.admin.deleteUser(cleanup.userId);
    if (deleted.error && Number(deleted.error.status) !== 404) {
      throw new Error('AUTH_DELETE_FAILED');
    }
    await serviceRpc('finish_zh_registration_cleanup', {
      p_operation_id: cleanup.operationId,
      p_success: true,
      p_error_code: null,
    });
  } catch {
    // A claimed lease expires and becomes retryable. This maintenance is
    // deliberately best-effort and cannot make a public auth request fail.
  }
}

export async function prepareZhRegistration(
  value: ZhRegistrationProfile,
  relyingParty: ZhWebAuthnRelyingParty,
) {
  await reconcileOneZhRegistrationCleanup();
  const currentLegal = await getCurrentLegalPolicies();
  const profile = normalizeRegistrationProfile(value, currentLegal);
  const operationId = randomUUID();
  const challenge = randomBytes(32);
  const userID = randomBytes(32);
  const options = await generateRegistrationOptions({
    rpName: 'SafetyHub',
    rpID: relyingParty.rpID,
    userName: 'SafetyHub 用户',
    userDisplayName: 'SafetyHub 用户',
    userID,
    challenge,
    timeout: 2 * 60 * 1000,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
  });
  if (!USER_HANDLE_PATTERN.test(options.user.id)) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  const syntheticEmail = `${randomBytes(16).toString('hex')}@auth.invalid`;
  const prepared = record(
    await serviceRpc('prepare_zh_registration_operation', {
      p_operation_id: operationId,
      p_challenge_sha256: sha256Hex(options.challenge),
      p_request_hash: profile.requestHash,
      p_user_handle: options.user.id,
      p_synthetic_email: syntheticEmail,
    }),
  );
  if (prepared?.operationId !== operationId || !validDate(prepared.expiresAt)) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  return { operationId, publicKey: options, expiresAt: prepared.expiresAt };
}

export async function verifyZhRegistration(
  value: ZhRegistrationVerifyRequest,
  relyingParty: ZhWebAuthnRelyingParty,
) {
  const currentLegal = await getCurrentLegalPolicies();
  const [profile, operation, avatar] = await Promise.all([
    Promise.resolve(normalizeRegistrationProfile(value, currentLegal)),
    getRegistrationOperation(value.operationId),
    normalizeAndBindAvatar(value),
  ]);
  if (
    operation.operationId !== value.operationId ||
    operation.requestHash !== profile.requestHash ||
    operation.consumedAt !== null ||
    Date.parse(operation.expiresAt) <= Date.now() ||
    !['prepared', 'auth_created', 'storage_written'].includes(operation.state) ||
    !sameBase64url(value.response.id, value.response.rawId)
  ) {
    throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: value.response as RegistrationResponseJSON,
      expectedChallenge: challengeMatches(operation.challengeSha256),
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpID,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  }
  const registration = verification.registrationInfo;
  if (
    !verification.verified ||
    !registration ||
    !registration.userVerified ||
    registration.origin !== relyingParty.origin ||
    registration.rpID !== relyingParty.rpID ||
    registration.credential.id !== value.response.id
  ) {
    throw new ZhWebAuthnError(REGISTRATION_FAILURE, 400);
  }

  let userId = operation.authUserId;
  let avatarObjectKey = operation.avatarObjectKey;
  try {
    if (!userId) {
      const admin = createAdminClient();
      const created = await admin.auth.admin.createUser({
        email: operation.syntheticEmail,
        email_confirm: true,
        app_metadata: {
          safetyhub_auth_kind: 'zh_passkey',
          safetyhub_registration_operation_id: operation.operationId,
        },
        user_metadata: { preferred_locale: 'zh' },
      });
      if (!created.error && created.data.user?.id) userId = created.data.user.id;
      if (!userId) {
        const recovered = await getRegistrationOperation(value.operationId);
        userId = recovered.authUserId;
      }
      if (!userId) throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
    }
    await serviceRpc('attach_zh_registration_auth_user', {
      p_operation_id: operation.operationId,
      p_user_id: userId,
    });
    avatarObjectKey = await persistRegistrationAvatar(operation.operationId, userId, avatar);
    const recovery = createRecoveryMaterial();
    const finalized = record(
      await serviceRpc('finalize_zh_registration', {
        p_operation_id: operation.operationId,
        p_request_hash: profile.requestHash,
        p_credential_id: registration.credential.id,
        p_public_key_base64: Buffer.from(registration.credential.publicKey).toString('base64'),
        p_signature_counter: registration.credential.counter,
        p_transports: transports(
          registration.credential.transports ?? value.response.response.transports,
        ),
        p_device_type: registration.credentialDeviceType,
        p_backed_up: registration.credentialBackedUp,
        p_name: profile.name,
        p_surname: profile.surname,
        p_job: profile.job,
        p_organization: profile.organization,
        p_phone_country_iso2: profile.phoneCountryIso2,
        p_phone_e164: profile.phoneE164,
        p_privacy_version: profile.privacyVersion,
        p_privacy_body_revision: profile.privacyBodyRevision,
        p_terms_version: profile.termsVersion,
        p_terms_body_revision: profile.termsBodyRevision,
        p_recovery_locator: recovery.locator,
        p_recovery_salt: recovery.salt,
        p_recovery_digest: recovery.digest,
      }),
    );
    if (
      finalized?.state !== 'completed' ||
      finalized.userId !== userId ||
      finalized.syntheticEmail !== operation.syntheticEmail ||
      finalized.approvalState !== 'pending'
    ) {
      throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
    }
    await issueSyntheticSession(userId, operation.syntheticEmail);
    return {
      verified: true,
      approvalState: 'pending' as const,
      redirectTo: '/zh/profile' as const,
      recoveryCode: recovery.code,
    };
  } catch (error) {
    if (userId) {
      const latest = await getRegistrationOperation(operation.operationId).catch(() => null);
      if (latest?.state !== 'completed') {
        await compensateRegistration(operation.operationId, userId, avatarObjectKey);
      }
    }
    if (error instanceof ZhWebAuthnError) throw error;
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
}

export async function prepareZhAuthentication(relyingParty: ZhWebAuthnRelyingParty) {
  await reconcileOneZhRegistrationCleanup();
  const requestId = randomUUID();
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.rpID,
    challenge: randomBytes(32),
    timeout: 2 * 60 * 1000,
    userVerification: 'required',
  });
  const prepared = record(
    await serviceRpc('prepare_zh_authentication_challenge', {
      p_request_id: requestId,
      p_challenge_sha256: sha256Hex(options.challenge),
    }),
  );
  if (prepared?.requestId !== requestId || !validDate(prepared.expiresAt)) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  return { requestId, publicKey: options, expiresAt: prepared.expiresAt };
}

export async function verifyZhAuthentication(
  value: ZhAuthenticationVerifyRequest,
  relyingParty: ZhWebAuthnRelyingParty,
) {
  if (!sameBase64url(value.response.id, value.response.rawId)) {
    throw new ZhWebAuthnError(AUTHENTICATION_FAILURE, 400);
  }
  const context = parseAuthenticationContext(
    await serviceRpc('get_zh_authentication_context', {
      p_request_id: value.requestId,
      p_credential_id: value.response.id,
    }),
  );
  if (
    context.requestId !== value.requestId ||
    context.credentialId !== value.response.id ||
    !value.response.response.userHandle ||
    !sameBase64url(value.response.response.userHandle, context.userHandle)
  ) {
    throw new ZhWebAuthnError(AUTHENTICATION_FAILURE, 400);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: value.response as AuthenticationResponseJSON,
      expectedChallenge: challengeMatches(context.challengeSha256),
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpID,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: {
        id: context.credentialId,
        publicKey: new Uint8Array(Buffer.from(context.publicKeyBase64, 'base64')),
        counter: context.signatureCounter,
        transports: context.transports,
      },
    });
  } catch {
    throw new ZhWebAuthnError(AUTHENTICATION_FAILURE, 400);
  }
  if (
    !verification.verified ||
    !verification.authenticationInfo.userVerified ||
    verification.authenticationInfo.origin !== relyingParty.origin ||
    verification.authenticationInfo.rpID !== relyingParty.rpID ||
    verification.authenticationInfo.credentialID !== context.credentialId
  ) {
    throw new ZhWebAuthnError(AUTHENTICATION_FAILURE, 400);
  }
  const completed = record(
    await serviceRpc('complete_zh_authentication', {
      p_request_id: value.requestId,
      p_credential_id: context.credentialId,
      p_expected_counter: context.signatureCounter,
      p_new_counter: verification.authenticationInfo.newCounter,
      p_backed_up: verification.authenticationInfo.credentialBackedUp,
    }),
  );
  if (
    typeof completed?.userId !== 'string' ||
    !UUID_PATTERN.test(completed.userId) ||
    typeof completed.syntheticEmail !== 'string' ||
    !SYNTHETIC_EMAIL_PATTERN.test(completed.syntheticEmail)
  ) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  await issueSyntheticSession(completed.userId, completed.syntheticEmail);
  return { verified: true, redirectTo: '/zh/profile' as const };
}

async function verifiedRecoveryContext(code: string) {
  const parsed = parseRecoveryCode(code);
  if (!parsed) throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  const value = await serviceRpc('get_zh_recovery_context', { p_locator: parsed.locator });
  if (value === null) {
    // Do one full peppered digest even for a missing locator to reduce timing
    // distinction without persisting or logging the presented code.
    recoveryCodeMatches(parsed.code, '0'.repeat(32), '0'.repeat(64));
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  const context = parseRecoveryContext(value);
  if (!recoveryCodeMatches(parsed.code, context.salt, context.digest)) {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  return { parsed, context };
}

export async function processZhRecovery(
  value: ZhRecoveryRequest,
  relyingParty: ZhWebAuthnRelyingParty,
) {
  const { parsed, context } = await verifiedRecoveryContext(value.recoveryCode);
  if (value.action === 'options') {
    const requestId = randomUUID();
    const options = await generateRegistrationOptions({
      rpName: 'SafetyHub',
      rpID: relyingParty.rpID,
      userName: 'SafetyHub 用户',
      userDisplayName: 'SafetyHub 用户',
      userID: base64urlToBytes(context.userHandle),
      challenge: randomBytes(32),
      timeout: 2 * 60 * 1000,
      attestationType: 'none',
      excludeCredentials: context.activeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
    });
    const prepared = record(
      await serviceRpc('prepare_zh_recovery_challenge', {
        p_request_id: requestId,
        p_locator: parsed.locator,
        p_challenge_sha256: sha256Hex(options.challenge),
      }),
    );
    if (prepared?.requestId !== requestId || !validDate(prepared.expiresAt)) {
      throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
    }
    return {
      action: 'options' as const,
      requestId,
      publicKey: options,
      expiresAt: prepared.expiresAt,
    };
  }

  if (!sameBase64url(value.response.id, value.response.rawId)) {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  const verificationContext = parseRecoveryVerificationContext(
    await serviceRpc('get_zh_recovery_verification_context', {
      p_request_id: value.requestId,
      p_locator: parsed.locator,
    }),
  );
  if (
    verificationContext.userId !== context.userId ||
    verificationContext.userHandle !== context.userHandle ||
    verificationContext.digest !== context.digest
  ) {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: value.response as RegistrationResponseJSON,
      expectedChallenge: challengeMatches(verificationContext.challengeSha256),
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.rpID,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  const registration = verification.registrationInfo;
  if (
    !verification.verified ||
    !registration ||
    !registration.userVerified ||
    registration.origin !== relyingParty.origin ||
    registration.rpID !== relyingParty.rpID ||
    registration.credential.id !== value.response.id
  ) {
    throw new ZhWebAuthnError(RECOVERY_FAILURE, 400);
  }
  const nextRecovery = createRecoveryMaterial();
  const completed = record(
    await serviceRpc('complete_zh_recovery', {
      p_request_id: value.requestId,
      p_locator: parsed.locator,
      p_credential_id: registration.credential.id,
      p_public_key_base64: Buffer.from(registration.credential.publicKey).toString('base64'),
      p_signature_counter: registration.credential.counter,
      p_transports: transports(
        registration.credential.transports ?? value.response.response.transports,
      ),
      p_device_type: registration.credentialDeviceType,
      p_backed_up: registration.credentialBackedUp,
      p_next_locator: nextRecovery.locator,
      p_next_salt: nextRecovery.salt,
      p_next_digest: nextRecovery.digest,
    }),
  );
  if (
    completed?.userId !== context.userId ||
    typeof completed.syntheticEmail !== 'string' ||
    !SYNTHETIC_EMAIL_PATTERN.test(completed.syntheticEmail)
  ) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  await issueSyntheticSession(context.userId, completed.syntheticEmail);
  return {
    action: 'verified' as const,
    verified: true,
    redirectTo: '/zh/profile' as const,
    recoveryCode: nextRecovery.code,
  };
}

export async function resetZhCredential(
  targetUserId: string,
  reason: string,
  idempotencyKey: string,
  metadata: AdminRequestMetadata,
) {
  const actor = await requireCapability('identity.manage');
  await consumeCoarseQuota('admin.zh_credential.reset', metadata.ipHash);
  const material = deriveAdminReenrollmentMaterial({
    actorId: actor.user.id,
    targetUserId,
    idempotencyKey,
  });
  const client = (await createClient()) as unknown as RpcClient;
  const result = record(
    unwrapRpcMutationResponse(
      await client.rpc('reset_zh_credential', {
        p_target_user_id: targetUserId,
        p_reason: reason,
        p_idempotency_key: idempotencyKey,
        p_locator: material.locator,
        p_salt: material.salt,
        p_digest: material.digest,
      }),
    ),
  );
  if (
    result?.userId !== targetUserId ||
    result.locator !== material.locator ||
    !validDate(result.expiresAt) ||
    typeof result.replayed !== 'boolean'
  ) {
    throw new ZhWebAuthnError(AUTH_UNAVAILABLE, 503);
  }
  return {
    userId: targetUserId,
    replayed: result.replayed,
    expiresAt: result.expiresAt,
    reEnrollmentCode: material.code,
  };
}

export function recoveryLocator(value: string) {
  return parseRecoveryCode(value)?.locator ?? null;
}
