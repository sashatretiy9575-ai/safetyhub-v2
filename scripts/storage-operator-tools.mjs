import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const PRODUCTION_PROJECT_REF = 'vezgxdooijznpjqrpvcv';
export const AVATAR_BUCKET = 'profile-avatars';
export const AVATAR_FILE_SIZE_LIMIT_BYTES = 102_400;
export const AVATAR_ALLOWED_MIME_TYPES = Object.freeze(['image/webp']);

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'u');
const LEGACY_AVATAR_RE = new RegExp(`^(${UUID_PATTERN})/avatar\\.webp$`, 'u');
const IMMUTABLE_AVATAR_RE = new RegExp(`^(${UUID_PATTERN})/objects/(${UUID_PATTERN})\\.webp$`, 'u');
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/u;
const ENCRYPTED_MAGIC = Buffer.from('SAFETYHUB-ENCRYPTED-V1\n', 'ascii');
const ENCRYPTED_TAG_BYTES = 16;
const MAX_ENCRYPTED_HEADER_BYTES = 4_096;
const SCRYPT_PARAMETERS = Object.freeze({ N: 16_384, r: 8, p: 1 });
const MAX_PAGES = 1_000_000;
const MAX_VISIBLE_DIRECTORIES = 1_000_000;
const MAX_VISIBLE_OBJECTS = 5_000_000;
const MAX_STORAGE_LIST_REQUESTS = 10_000_000;
const PRIVATE_OUTPUT_ACKNOWLEDGEMENT =
  'private-directory-outside-repository-with-encryption-at-rest';

const COMMON_CONFIG_KEYS = [
  'version',
  'operation',
  'classificationMode',
  'productionProjectRef',
  'supabaseUrl',
  'bucket',
  'serviceRoleKeyEnv',
  'pageSize',
  'requestTimeoutMs',
];

const OPERATION_CONFIG = Object.freeze({
  'visible-inventory': {
    keys: [...COMMON_CONFIG_KEYS, 'evidenceSaltEnv'],
    required: [...COMMON_CONFIG_KEYS, 'evidenceSaltEnv'],
  },
  'avatar-backup': {
    keys: [
      ...COMMON_CONFIG_KEYS,
      'archivePassphraseEnv',
      'privateOutputAcknowledgement',
      'backupBlockedVisibleObjects',
    ],
    required: [...COMMON_CONFIG_KEYS, 'archivePassphraseEnv', 'privateOutputAcknowledgement'],
  },
});

export class OperatorToolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperatorToolError';
    this.code = code;
  }
}

function fail(code) {
  throw new OperatorToolError(code);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictKeys(value, allowed, required) {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(value);
  requireCondition(
    keys.every((key) => allowedSet.has(key)),
    'CONFIG_UNKNOWN_FIELD',
  );
  requireCondition(
    required.every((key) => keys.includes(key)),
    'CONFIG_MISSING_FIELD',
  );
}

function validEnvName(value) {
  return typeof value === 'string' && ENV_NAME_RE.test(value) && !value.startsWith('NEXT_PUBLIC_');
}

function validateProductionUrl(value, projectRef) {
  requireCondition(typeof value === 'string', 'CONFIG_INVALID_SUPABASE_URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('CONFIG_INVALID_SUPABASE_URL');
  }
  requireCondition(parsed.protocol === 'https:', 'CONFIG_INVALID_SUPABASE_URL');
  requireCondition(parsed.username === '' && parsed.password === '', 'CONFIG_INVALID_SUPABASE_URL');
  requireCondition(parsed.port === '', 'CONFIG_INVALID_SUPABASE_URL');
  requireCondition(
    parsed.pathname === '/' && parsed.search === '' && parsed.hash === '',
    'CONFIG_INVALID_SUPABASE_URL',
  );
  requireCondition(parsed.hostname === `${projectRef}.supabase.co`, 'CONFIG_PROJECT_URL_MISMATCH');
  return parsed.origin;
}

export function validateOperatorConfig(value, expectedOperation) {
  requireCondition(isPlainObject(value), 'CONFIG_NOT_AN_OBJECT');
  const operationConfig = OPERATION_CONFIG[expectedOperation];
  requireCondition(operationConfig !== undefined, 'CONFIG_UNSUPPORTED_OPERATION');
  strictKeys(value, operationConfig.keys, operationConfig.required);

  requireCondition(value.version === 1, 'CONFIG_UNSUPPORTED_VERSION');
  requireCondition(value.operation === expectedOperation, 'CONFIG_OPERATION_MISMATCH');
  const forensicBackup =
    expectedOperation === 'avatar-backup' && value.backupBlockedVisibleObjects === true;
  requireCondition(
    value.classificationMode ===
      (forensicBackup ? 'visible-metadata-forensic-backup' : 'pre-700-visible-metadata'),
    'CONFIG_UNSUPPORTED_CLASSIFICATION_MODE',
  );
  requireCondition(
    value.productionProjectRef === PRODUCTION_PROJECT_REF,
    'CONFIG_PRODUCTION_REF_MISMATCH',
  );
  requireCondition(value.bucket === AVATAR_BUCKET, 'CONFIG_BUCKET_MISMATCH');
  requireCondition(
    value.serviceRoleKeyEnv === 'SUPABASE_SECRET_KEY',
    'CONFIG_SERVICE_KEY_ENV_MISMATCH',
  );
  requireCondition(validEnvName(value.serviceRoleKeyEnv), 'CONFIG_INVALID_ENV_NAME');
  requireCondition(
    Number.isInteger(value.pageSize) && value.pageSize >= 1 && value.pageSize <= 1_000,
    'CONFIG_INVALID_PAGE_SIZE',
  );
  requireCondition(
    Number.isInteger(value.requestTimeoutMs) &&
      value.requestTimeoutMs >= 1_000 &&
      value.requestTimeoutMs <= 120_000,
    'CONFIG_INVALID_TIMEOUT',
  );

  const supabaseUrl = validateProductionUrl(value.supabaseUrl, value.productionProjectRef);

  if (expectedOperation === 'visible-inventory') {
    requireCondition(
      value.evidenceSaltEnv === 'STORAGE_INVENTORY_EVIDENCE_SALT',
      'CONFIG_EVIDENCE_SALT_ENV_MISMATCH',
    );
    requireCondition(validEnvName(value.evidenceSaltEnv), 'CONFIG_INVALID_ENV_NAME');
  } else {
    requireCondition(
      value.backupBlockedVisibleObjects === undefined || value.backupBlockedVisibleObjects === true,
      'CONFIG_INVALID_FORENSIC_BACKUP_FLAG',
    );
    requireCondition(
      value.archivePassphraseEnv === 'STORAGE_BACKUP_ARCHIVE_PASSPHRASE',
      'CONFIG_ARCHIVE_PASSPHRASE_ENV_MISMATCH',
    );
    requireCondition(validEnvName(value.archivePassphraseEnv), 'CONFIG_INVALID_ENV_NAME');
    requireCondition(
      value.privateOutputAcknowledgement === PRIVATE_OUTPUT_ACKNOWLEDGEMENT,
      'CONFIG_PRIVATE_OUTPUT_NOT_ACKNOWLEDGED',
    );
  }

  return Object.freeze({ ...value, supabaseUrl });
}

export async function readOperatorConfig(file, expectedOperation) {
  requireCondition(typeof file === 'string' && file.length > 0, 'CONFIG_PATH_REQUIRED');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    fail('CONFIG_READ_FAILED');
  }
  requireCondition(Buffer.byteLength(raw, 'utf8') <= 65_536, 'CONFIG_TOO_LARGE');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('CONFIG_INVALID_JSON');
  }
  return validateOperatorConfig(parsed, expectedOperation);
}

export function confirmProductionRef(config, confirmation) {
  requireCondition(
    typeof confirmation === 'string' &&
      confirmation === PRODUCTION_PROJECT_REF &&
      confirmation === config.productionProjectRef,
    'PRODUCTION_REF_CONFIRMATION_REQUIRED',
  );
}

function requiredSecret(environment, name, kind) {
  const value = environment[name];
  requireCondition(typeof value === 'string', `${kind}_ENV_MISSING`);
  requireCondition(!/[\r\n]/u.test(value), `${kind}_ENV_INVALID`);
  requireCondition(Buffer.byteLength(value, 'utf8') >= 32, `${kind}_ENV_TOO_SHORT`);
  requireCondition(!/replace|example|your-|placeholder/iu.test(value), `${kind}_ENV_PLACEHOLDER`);
  return value;
}

function decodeJwtPayload(value) {
  const pieces = value.split('.');
  if (pieces.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readServiceCredential(config, environment = process.env) {
  const value = requiredSecret(environment, config.serviceRoleKeyEnv, 'SERVICE_KEY');
  const legacyPayload = decodeJwtPayload(value);
  const isModernSecret = value.startsWith('sb_secret_');
  const isLegacyServiceRole = legacyPayload?.role === 'service_role';
  requireCondition(isModernSecret || isLegacyServiceRole, 'SERVICE_KEY_WRONG_KIND');
  return value;
}

export function readEvidenceSalt(config, environment = process.env) {
  return Buffer.from(requiredSecret(environment, config.evidenceSaltEnv, 'EVIDENCE_SALT'), 'utf8');
}

export function readArchivePassphrase(config, environment = process.env) {
  return requiredSecret(environment, config.archivePassphraseEnv, 'ARCHIVE_PASSPHRASE');
}

export function createBoundedFetch(timeoutMs, fetchImplementation = globalThis.fetch) {
  requireCondition(typeof fetchImplementation === 'function', 'FETCH_UNAVAILABLE');
  return async (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetchImplementation(input, { ...init, signal });
  };
}

function safeFingerprint(salt, domain, value) {
  return `hmac-sha256:${createHmac('sha256', salt)
    .update('safetyhub-storage-evidence-v1\0', 'utf8')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')}`;
}

function normalizeError(_error, code) {
  return new OperatorToolError(code);
}

function validateUuid(value, code) {
  requireCondition(typeof value === 'string' && UUID_RE.test(value), code);
  return value;
}

async function listAllAuthUsers(client, pageSize) {
  const liveUsers = new Set();
  const seenUsers = new Set();
  let deletedUsers = 0;
  let page = 1;
  for (; page <= MAX_PAGES; page += 1) {
    let response;
    try {
      response = await client.auth.admin.listUsers({ page, perPage: pageSize });
    } catch (error) {
      throw normalizeError(error, 'AUTH_USERS_LIST_FAILED');
    }
    if (response?.error) throw normalizeError(response.error, 'AUTH_USERS_LIST_FAILED');
    const users = response?.data?.users;
    requireCondition(Array.isArray(users), 'AUTH_USERS_RESPONSE_MALFORMED');
    for (const user of users) {
      requireCondition(isPlainObject(user), 'AUTH_USER_MALFORMED');
      const id = validateUuid(user.id, 'AUTH_USER_ID_MALFORMED');
      requireCondition(!seenUsers.has(id), 'AUTH_USER_DUPLICATE');
      seenUsers.add(id);
      if (user.deleted_at === null || user.deleted_at === undefined) liveUsers.add(id);
      else deletedUsers += 1;
    }
    if (users.length < pageSize) break;
  }
  requireCondition(page <= MAX_PAGES, 'AUTH_USERS_PAGINATION_LIMIT');
  return { liveUsers, deletedUsers };
}

async function listAllProfiles(client, pageSize) {
  const profiles = new Map();
  let offset = 0;
  let pages = 0;
  for (; pages < MAX_PAGES; pages += 1) {
    let response;
    try {
      response = await client
        .from('profiles')
        .select('id,avatar_updated_at')
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
    } catch (error) {
      throw normalizeError(error, 'PROFILES_LIST_FAILED');
    }
    if (response?.error) throw normalizeError(response.error, 'PROFILES_LIST_FAILED');
    requireCondition(Array.isArray(response?.data), 'PROFILES_RESPONSE_MALFORMED');
    for (const profile of response.data) {
      requireCondition(isPlainObject(profile), 'PROFILE_MALFORMED');
      const id = validateUuid(profile.id, 'PROFILE_ID_MALFORMED');
      requireCondition(!profiles.has(id), 'PROFILE_DUPLICATE');
      profiles.set(id, { avatarUpdatedAt: profile.avatar_updated_at });
    }
    if (response.data.length < pageSize) break;
    offset += pageSize;
  }
  requireCondition(pages < MAX_PAGES, 'PROFILES_PAGINATION_LIMIT');
  return profiles;
}

async function listAllAccountControls(client, pageSize) {
  const accountControls = new Map();
  let offset = 0;
  let pages = 0;
  for (; pages < MAX_PAGES; pages += 1) {
    let response;
    try {
      response = await client
        .from('account_controls')
        .select('user_id,deletion_pending')
        .order('user_id', { ascending: true })
        .range(offset, offset + pageSize - 1);
    } catch (error) {
      throw normalizeError(error, 'ACCOUNT_CONTROLS_LIST_FAILED');
    }
    if (response?.error) {
      throw normalizeError(response.error, 'ACCOUNT_CONTROLS_LIST_FAILED');
    }
    requireCondition(Array.isArray(response?.data), 'ACCOUNT_CONTROLS_RESPONSE_MALFORMED');
    for (const control of response.data) {
      requireCondition(isPlainObject(control), 'ACCOUNT_CONTROL_MALFORMED');
      const userId = validateUuid(control.user_id, 'ACCOUNT_CONTROL_USER_ID_MALFORMED');
      requireCondition(
        typeof control.deletion_pending === 'boolean',
        'ACCOUNT_CONTROL_DELETION_PENDING_MALFORMED',
      );
      requireCondition(!accountControls.has(userId), 'ACCOUNT_CONTROL_DUPLICATE');
      accountControls.set(userId, { deletionPending: control.deletion_pending });
    }
    if (response.data.length < pageSize) break;
    offset += pageSize;
  }
  requireCondition(pages < MAX_PAGES, 'ACCOUNT_CONTROLS_PAGINATION_LIMIT');
  return accountControls;
}

function safePathComponent(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function isStorageFolder(item) {
  if (item.id === null) {
    requireCondition(item.metadata === null, 'STORAGE_FOLDER_ENTRY_MALFORMED');
    return true;
  }
  requireCondition(
    typeof item.id === 'string' && item.id.length > 0,
    'STORAGE_FILE_ENTRY_MALFORMED',
  );
  requireCondition(isPlainObject(item.metadata), 'STORAGE_FILE_ENTRY_MALFORMED');
  return false;
}

function visibleByteSize(item) {
  const value = item?.metadata?.size;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

async function assertAvatarBucketConfiguration(client, bucket) {
  requireCondition(
    typeof client?.storage?.getBucket === 'function',
    'STORAGE_BUCKET_PREFLIGHT_UNSUPPORTED',
  );
  let response;
  try {
    response = await client.storage.getBucket(bucket);
  } catch (error) {
    throw normalizeError(error, 'STORAGE_BUCKET_PREFLIGHT_FAILED');
  }
  if (response?.error) {
    throw normalizeError(response.error, 'STORAGE_BUCKET_PREFLIGHT_FAILED');
  }
  const data = response?.data;
  requireCondition(isPlainObject(data), 'STORAGE_BUCKET_CONFIGURATION_MALFORMED');
  requireCondition(
    typeof data.id === 'string' &&
      typeof data.name === 'string' &&
      typeof data.public === 'boolean' &&
      Number.isSafeInteger(data.file_size_limit) &&
      Array.isArray(data.allowed_mime_types) &&
      data.allowed_mime_types.every((value) => typeof value === 'string'),
    'STORAGE_BUCKET_CONFIGURATION_MALFORMED',
  );
  requireCondition(
    data.id === bucket &&
      data.name === bucket &&
      data.public === false &&
      data.file_size_limit === AVATAR_FILE_SIZE_LIMIT_BYTES &&
      data.allowed_mime_types.length === AVATAR_ALLOWED_MIME_TYPES.length &&
      data.allowed_mime_types.every((value, index) => value === AVATAR_ALLOWED_MIME_TYPES[index]),
    'STORAGE_BUCKET_CONFIGURATION_DRIFT',
  );
  return Object.freeze({
    private: true,
    fileSizeLimitBytes: AVATAR_FILE_SIZE_LIMIT_BYTES,
    allowedMimeTypes: [...AVATAR_ALLOWED_MIME_TYPES],
  });
}

async function listVisibleStorageObjects(client, bucket, pageSize) {
  const storage = client.storage.from(bucket);
  const directories = [''];
  const seenDirectories = new Set(['']);
  const seenObjects = new Set();
  const objects = [];
  let directoryCount = 0;
  let listRequests = 0;

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const prefix = directories[directoryIndex];
    let offset = 0;
    let pages = 0;
    directoryCount += 1;
    requireCondition(directoryCount <= MAX_VISIBLE_DIRECTORIES, 'STORAGE_DIRECTORY_LIMIT');
    for (; pages < MAX_PAGES; pages += 1) {
      listRequests += 1;
      requireCondition(listRequests <= MAX_STORAGE_LIST_REQUESTS, 'STORAGE_LIST_REQUEST_LIMIT');
      let response;
      try {
        response = await storage.list(prefix, {
          limit: pageSize,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        });
      } catch (error) {
        throw normalizeError(error, 'STORAGE_LIST_FAILED');
      }
      if (response?.error) throw normalizeError(response.error, 'STORAGE_LIST_FAILED');
      requireCondition(Array.isArray(response?.data), 'STORAGE_LIST_RESPONSE_MALFORMED');

      for (const item of response.data) {
        requireCondition(isPlainObject(item), 'STORAGE_LIST_ENTRY_MALFORMED');
        requireCondition(safePathComponent(item.name), 'STORAGE_LIST_NAME_MALFORMED');
        const fullName = prefix === '' ? item.name : `${prefix}/${item.name}`;
        if (isStorageFolder(item)) {
          requireCondition(!seenDirectories.has(fullName), 'STORAGE_DIRECTORY_DUPLICATE');
          seenDirectories.add(fullName);
          directories.push(fullName);
        } else {
          requireCondition(!seenObjects.has(fullName), 'STORAGE_OBJECT_DUPLICATE');
          seenObjects.add(fullName);
          objects.push({
            key: fullName,
            id: item.id ?? null,
            createdAt: item.created_at ?? null,
            updatedAt: item.updated_at ?? null,
            lastAccessedAt: item.last_accessed_at ?? null,
            metadata: isPlainObject(item.metadata) ? { ...item.metadata } : null,
            byteSize: visibleByteSize(item),
          });
          requireCondition(objects.length <= MAX_VISIBLE_OBJECTS, 'STORAGE_OBJECT_LIMIT');
        }
      }

      if (response.data.length < pageSize) break;
      offset += pageSize;
    }
    requireCondition(pages < MAX_PAGES, 'STORAGE_PAGINATION_LIMIT');
  }

  objects.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return { objects, directoryCount };
}

function hasTrustedAvatarMarker(profile) {
  if (!profile || typeof profile.avatarUpdatedAt !== 'string') return false;
  if (profile.avatarUpdatedAt.trim() === '') return false;
  return Number.isFinite(Date.parse(profile.avatarUpdatedAt));
}

function ownerPrefix(key) {
  const separator = key.indexOf('/');
  const candidate = separator === -1 ? key : key.slice(0, separator);
  return UUID_RE.test(candidate) ? candidate : null;
}

function classifyPre700VisibleState(state, salt, bucket) {
  const prefixCounts = new Map();
  for (const object of state.storage.objects) {
    const owner = ownerPrefix(object.key);
    if (owner) prefixCounts.set(owner, (prefixCounts.get(owner) ?? 0) + 1);
  }

  const eligible = [];
  const blocked = [];
  const reasonCounts = Object.create(null);
  for (const object of state.storage.objects) {
    const reasons = new Set();
    const legacyMatch = LEGACY_AVATAR_RE.exec(object.key);
    const immutableMatch = IMMUTABLE_AVATAR_RE.exec(object.key);
    const owner = legacyMatch?.[1] ?? immutableMatch?.[1] ?? ownerPrefix(object.key);

    if (!legacyMatch) {
      reasons.add(immutableMatch ? 'pre700_immutable_object' : 'malformed_or_nested_key');
    }
    if (owner && !state.auth.liveUsers.has(owner)) reasons.add('missing_live_auth_user');
    if (owner && (prefixCounts.get(owner) ?? 0) !== 1) reasons.add('ambiguous_user_prefix');
    if (legacyMatch && !hasTrustedAvatarMarker(state.profiles.get(legacyMatch[1]))) {
      reasons.add('missing_trusted_avatar_marker');
    }
    if (legacyMatch) {
      const control = state.accountControls.get(legacyMatch[1]);
      if (!control) reasons.add('missing_account_control');
      else if (control.deletionPending) reasons.add('account_deletion_pending');
    }
    if (object.byteSize === null) reasons.add('invalid_visible_byte_size');
    else if (object.byteSize < 1 || object.byteSize > AVATAR_FILE_SIZE_LIMIT_BYTES) {
      reasons.add('visible_byte_size_out_of_range');
    }
    const mimeType = object.metadata?.mimetype ?? object.metadata?.contentType;
    if (mimeType !== undefined && mimeType !== null && mimeType !== 'image/webp') {
      reasons.add('unexpected_visible_mime');
    }

    if (reasons.size === 0) {
      eligible.push({ ...object, userId: legacyMatch[1] });
    } else {
      const sortedReasons = [...reasons].sort();
      for (const reason of sortedReasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      blocked.push({ object, owner, reasons: sortedReasons });
    }
  }

  const authWithoutProfile = [...state.auth.liveUsers].filter((id) => !state.profiles.has(id));
  const profilesWithoutAuth = [...state.profiles.keys()].filter(
    (id) => !state.auth.liveUsers.has(id),
  );
  const authWithoutAccountControl = [...state.auth.liveUsers].filter(
    (id) => !state.accountControls.has(id),
  );
  const accountControlsWithoutAuth = [...state.accountControls.keys()].filter(
    (id) => !state.auth.liveUsers.has(id),
  );
  const deletionPendingAccountControls = [...state.accountControls.values()].filter(
    (control) => control.deletionPending,
  ).length;
  const findings = blocked.map(({ object, owner, reasons }) => ({
    objectFingerprint: safeFingerprint(salt, 'visible-object', `${bucket}\0${object.key}`),
    ...(owner ? { ownerFingerprint: safeFingerprint(salt, 'auth-user', owner) } : {}),
    reasons,
  }));
  findings.push(
    ...authWithoutProfile.map((id) => ({
      subjectFingerprint: safeFingerprint(salt, 'auth-user', id),
      reasons: ['auth_user_without_profile'],
    })),
    ...profilesWithoutAuth.map((id) => ({
      subjectFingerprint: safeFingerprint(salt, 'profile', id),
      reasons: ['profile_without_live_auth_user'],
    })),
    ...authWithoutAccountControl.map((id) => ({
      subjectFingerprint: safeFingerprint(salt, 'auth-user', id),
      reasons: ['auth_user_without_account_control'],
    })),
    ...accountControlsWithoutAuth.map((id) => ({
      subjectFingerprint: safeFingerprint(salt, 'account-control', id),
      reasons: ['account_control_without_live_auth_user'],
    })),
  );

  return {
    eligible,
    blocked,
    reportDetails: {
      counts: {
        liveAuthUsers: state.auth.liveUsers.size,
        deletedAuthUsersReturnedByApi: state.auth.deletedUsers,
        profiles: state.profiles.size,
        accountControls: state.accountControls.size,
        deletionPendingAccountControls,
        authUsersWithoutProfile: authWithoutProfile.length,
        profilesWithoutLiveAuthUser: profilesWithoutAuth.length,
        authUsersWithoutAccountControl: authWithoutAccountControl.length,
        accountControlsWithoutLiveAuthUser: accountControlsWithoutAuth.length,
        visibleDirectoriesVisited: state.storage.directoryCount,
        visibleObjects: state.storage.objects.length,
        eligibleForBackfillObjects: eligible.length,
        visibleMetadataBlockerObjects: blocked.length,
      },
      blockerReasonCounts: Object.fromEntries(
        Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right, 'en')),
      ),
      findings: findings.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'),
      ),
    },
  };
}

async function collectVisibleState(client, config) {
  const bucketConfiguration = await assertAvatarBucketConfiguration(client, config.bucket);
  const [auth, profiles, accountControls, storage] = await Promise.all([
    listAllAuthUsers(client, config.pageSize),
    listAllProfiles(client, config.pageSize),
    listAllAccountControls(client, config.pageSize),
    listVisibleStorageObjects(client, config.bucket, config.pageSize),
  ]);
  return { auth, profiles, accountControls, storage, bucketConfiguration };
}

function makeVisibleInventoryReport(config, classified, bucketConfiguration, capturedAt) {
  const blockerCount = classified.reportDetails.counts.visibleMetadataBlockerObjects;
  return {
    reportVersion: 1,
    kind: 'safetyhub-visible-storage-metadata-inventory',
    capturedAt,
    projectRef: config.productionProjectRef,
    bucket: config.bucket,
    classificationMode: config.classificationMode,
    coverage: {
      recursivelyPaginatedVisibleBucketMetadata: true,
      authUsersJoinedInMemory: true,
      profilesJoinedInMemory: true,
      accountControlsJoinedInMemory: true,
      readOnlyBucketConfigurationPreflightVerified: true,
      storageBytesRead: false,
      physicalBackendOrVersionInventoryPerformed: false,
      sourceConsistencyOrWriteDrainVerifiedByTool: false,
    },
    ...classified.reportDetails,
    verifiedBucketConfiguration: bucketConfiguration,
    visibleMetadataGate: blockerCount === 0 ? 'clear' : 'blocked',
    backendPhysicalOrVersionVerdict: 'not-assessed',
    limitations: [
      'This report covers only objects visible through the documented Storage listing API.',
      'It does not inspect physical backend bytes, hidden backend versions, sidecars, retry queues, or dead letters.',
      'A clear visible-metadata gate is not a zero-backend-orphan verdict.',
      'Consistency still depends on an externally enforced write drain for the full capture interval.',
    ],
  };
}

export async function runVisibleInventory({
  client,
  config,
  evidenceSalt,
  now = () => new Date(),
}) {
  requireCondition(client !== null && typeof client === 'object', 'CLIENT_REQUIRED');
  requireCondition(Buffer.byteLength(evidenceSalt) >= 32, 'EVIDENCE_SALT_TOO_SHORT');
  const state = await collectVisibleState(client, config);
  const classified = classifyPre700VisibleState(state, evidenceSalt, config.bucket);
  return makeVisibleInventoryReport(
    config,
    classified,
    state.bucketConfiguration,
    now().toISOString(),
  );
}

function insideOrEqual(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function validatePrivateOutputDirectory(outputDirectory, repositoryRoot) {
  requireCondition(
    typeof outputDirectory === 'string' && path.isAbsolute(outputDirectory),
    'OUTPUT_DIRECTORY_MUST_BE_ABSOLUTE',
  );
  let outputStats;
  let repoStats;
  try {
    [outputStats, repoStats] = await Promise.all([lstat(outputDirectory), lstat(repositoryRoot)]);
  } catch {
    fail('OUTPUT_DIRECTORY_OR_REPOSITORY_UNAVAILABLE');
  }
  requireCondition(outputStats.isDirectory(), 'OUTPUT_PATH_NOT_DIRECTORY');
  requireCondition(repoStats.isDirectory(), 'REPOSITORY_PATH_NOT_DIRECTORY');
  requireCondition(!outputStats.isSymbolicLink(), 'OUTPUT_DIRECTORY_SYMLINK_REJECTED');
  const [resolvedOutput, resolvedRepository] = await Promise.all([
    realpath(outputDirectory),
    realpath(repositoryRoot),
  ]);
  requireCondition(
    path.parse(resolvedOutput).root !== resolvedOutput,
    'OUTPUT_DIRECTORY_ROOT_REJECTED',
  );
  requireCondition(
    !insideOrEqual(resolvedRepository, resolvedOutput),
    'OUTPUT_DIRECTORY_INSIDE_REPOSITORY',
  );
  requireCondition(
    !insideOrEqual(resolvedOutput, resolvedRepository),
    'OUTPUT_DIRECTORY_ANCESTOR_OF_REPOSITORY',
  );
  return resolvedOutput;
}

function writeOctal(header, offset, length, value) {
  const encoded = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, '0');
  requireCondition(encoded.length <= length - 1, 'ARCHIVE_TAR_VALUE_TOO_LARGE');
  header.write(encoded, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function createTarHeader(name, size, modifiedAtSeconds) {
  const nameBytes = Buffer.from(name, 'utf8');
  requireCondition(nameBytes.length > 0 && nameBytes.length <= 100, 'ARCHIVE_TAR_NAME_INVALID');
  requireCondition(Number.isSafeInteger(size) && size >= 0, 'ARCHIVE_TAR_SIZE_INVALID');
  const header = Buffer.alloc(512);
  nameBytes.copy(header, 0);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, modifiedAtSeconds);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  requireCondition(checksumText.length <= 6, 'ARCHIVE_TAR_CHECKSUM_INVALID');
  header.write(checksumText, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function writeFully(fileHandle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await fileHandle.write(buffer, offset, buffer.length - offset, null);
    requireCondition(result.bytesWritten > 0, 'ARCHIVE_WRITE_FAILED');
    offset += result.bytesWritten;
  }
}

class EncryptedPayloadWriter {
  static async create(file, passphrase, contentType) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const header = {
      version: 1,
      cipher: 'aes-256-gcm',
      authTagBytes: ENCRYPTED_TAG_BYTES,
      kdf: 'scrypt',
      scrypt: SCRYPT_PARAMETERS,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      contentType,
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    const prefix = Buffer.concat([ENCRYPTED_MAGIC, length, headerBytes]);
    const key = scryptSync(passphrase, salt, 32, {
      ...SCRYPT_PARAMETERS,
      maxmem: 64 * 1024 * 1024,
    });
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: ENCRYPTED_TAG_BYTES,
    });
    key.fill(0);
    cipher.setAAD(prefix);
    let fileHandle;
    try {
      fileHandle = await open(file, 'wx', 0o600);
      await writeFully(fileHandle, prefix);
      return new EncryptedPayloadWriter(file, fileHandle, cipher);
    } catch {
      await fileHandle?.close().catch(() => {});
      fail('ARCHIVE_CREATE_FAILED');
    }
  }

  constructor(file, fileHandle, cipher) {
    this.file = file;
    this.fileHandle = fileHandle;
    this.cipher = cipher;
    this.finished = false;
  }

  async write(buffer) {
    requireCondition(!this.finished, 'ARCHIVE_WRITER_ALREADY_FINISHED');
    const encrypted = this.cipher.update(buffer);
    if (encrypted.length > 0) await writeFully(this.fileHandle, encrypted);
  }

  async finish() {
    requireCondition(!this.finished, 'ARCHIVE_WRITER_ALREADY_FINISHED');
    this.finished = true;
    try {
      const final = this.cipher.final();
      if (final.length > 0) await writeFully(this.fileHandle, final);
      await writeFully(this.fileHandle, this.cipher.getAuthTag());
      await this.fileHandle.sync();
      await this.fileHandle.close();
      await chmod(this.file, 0o600);
    } catch {
      await this.fileHandle.close().catch(() => {});
      fail('ARCHIVE_FINALIZE_FAILED');
    }
  }

  async abort() {
    await this.fileHandle.close().catch(() => {});
    await rm(this.file, { force: true }).catch(() => {});
  }
}

export class EncryptedTarWriter {
  static async create(
    file,
    passphrase,
    modifiedAtSeconds,
    contentType = 'application/x-tar; profile=safetyhub-avatar-backup-v1',
  ) {
    requireCondition(
      typeof contentType === 'string' && contentType.length > 0,
      'ARCHIVE_CONTENT_TYPE_INVALID',
    );
    const payload = await EncryptedPayloadWriter.create(file, passphrase, contentType);
    return new EncryptedTarWriter(payload, modifiedAtSeconds);
  }

  constructor(payload, modifiedAtSeconds) {
    this.payload = payload;
    this.modifiedAtSeconds = modifiedAtSeconds;
  }

  async addFile(name, bytes) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await this.payload.write(createTarHeader(name, data.length, this.modifiedAtSeconds));
    await this.payload.write(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) await this.payload.write(Buffer.alloc(padding));
  }

  async addWebStream(name, expectedByteSize, stream) {
    requireCondition(
      Number.isSafeInteger(expectedByteSize) && expectedByteSize >= 0,
      'ARCHIVE_TAR_SIZE_INVALID',
    );
    requireCondition(
      stream !== null && typeof stream === 'object' && typeof stream.getReader === 'function',
      'STORAGE_DOWNLOAD_STREAM_MALFORMED',
    );

    await this.payload.write(createTarHeader(name, expectedByteSize, this.modifiedAtSeconds));
    const reader = stream.getReader();
    const hash = createHash('sha256');
    let totalBytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        requireCondition(isPlainObject(result), 'STORAGE_DOWNLOAD_STREAM_MALFORMED');
        if (result.done === true) break;
        requireCondition(result.done === false, 'STORAGE_DOWNLOAD_STREAM_MALFORMED');
        requireCondition(result.value instanceof Uint8Array, 'STORAGE_DOWNLOAD_STREAM_MALFORMED');
        totalBytes += result.value.byteLength;
        if (totalBytes > expectedByteSize) {
          await reader.cancel().catch(() => {});
          fail('STORAGE_DOWNLOAD_SIZE_MISMATCH');
        }
        const chunk = Buffer.from(result.value);
        hash.update(chunk);
        await this.payload.write(chunk);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof OperatorToolError) throw error;
      throw normalizeError(error, 'STORAGE_DOWNLOAD_READ_FAILED');
    } finally {
      reader.releaseLock?.();
    }

    requireCondition(totalBytes === expectedByteSize, 'STORAGE_DOWNLOAD_SIZE_MISMATCH');
    const padding = (512 - (totalBytes % 512)) % 512;
    if (padding > 0) await this.payload.write(Buffer.alloc(padding));
    return { byteLength: totalBytes, sha256: hash.digest('hex') };
  }

  async finish() {
    await this.payload.write(Buffer.alloc(1_024));
    await this.payload.finish();
  }

  async abort() {
    await this.payload.abort();
  }
}

export async function encryptBufferToFile(file, passphrase, contentType, buffer) {
  const writer = await EncryptedPayloadWriter.create(file, passphrase, contentType);
  try {
    await writer.write(buffer);
    await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

function parseEncryptedHeader(value) {
  requireCondition(isPlainObject(value), 'ARCHIVE_HEADER_MALFORMED');
  strictKeys(
    value,
    ['version', 'cipher', 'authTagBytes', 'kdf', 'scrypt', 'salt', 'iv', 'contentType'],
    ['version', 'cipher', 'authTagBytes', 'kdf', 'scrypt', 'salt', 'iv', 'contentType'],
  );
  requireCondition(value.version === 1, 'ARCHIVE_HEADER_MALFORMED');
  requireCondition(value.cipher === 'aes-256-gcm', 'ARCHIVE_HEADER_MALFORMED');
  requireCondition(value.authTagBytes === ENCRYPTED_TAG_BYTES, 'ARCHIVE_HEADER_MALFORMED');
  requireCondition(value.kdf === 'scrypt', 'ARCHIVE_HEADER_MALFORMED');
  requireCondition(isPlainObject(value.scrypt), 'ARCHIVE_HEADER_MALFORMED');
  strictKeys(value.scrypt, ['N', 'r', 'p'], ['N', 'r', 'p']);
  requireCondition(
    value.scrypt.N === SCRYPT_PARAMETERS.N &&
      value.scrypt.r === SCRYPT_PARAMETERS.r &&
      value.scrypt.p === SCRYPT_PARAMETERS.p,
    'ARCHIVE_HEADER_MALFORMED',
  );
  requireCondition(
    typeof value.contentType === 'string' && value.contentType.length > 0,
    'ARCHIVE_HEADER_MALFORMED',
  );
  let salt;
  let iv;
  try {
    salt = Buffer.from(value.salt, 'base64');
    iv = Buffer.from(value.iv, 'base64');
  } catch {
    fail('ARCHIVE_HEADER_MALFORMED');
  }
  requireCondition(salt.length === 16 && iv.length === 12, 'ARCHIVE_HEADER_MALFORMED');
  return { salt, iv, contentType: value.contentType };
}

async function openEncryptedPayload(file, passphrase) {
  let fileHandle;
  try {
    fileHandle = await open(file, 'r');
    const fileStats = await fileHandle.stat();
    const fixedLength = ENCRYPTED_MAGIC.length + 4;
    requireCondition(fileStats.size > fixedLength + ENCRYPTED_TAG_BYTES, 'ARCHIVE_TRUNCATED');
    const fixed = Buffer.alloc(fixedLength);
    const fixedRead = await fileHandle.read(fixed, 0, fixed.length, 0);
    requireCondition(fixedRead.bytesRead === fixed.length, 'ARCHIVE_TRUNCATED');
    requireCondition(
      fixed.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC),
      'ARCHIVE_MAGIC_MISMATCH',
    );
    const headerLength = fixed.readUInt32BE(ENCRYPTED_MAGIC.length);
    requireCondition(
      headerLength > 0 && headerLength <= MAX_ENCRYPTED_HEADER_BYTES,
      'ARCHIVE_HEADER_MALFORMED',
    );
    const headerBytes = Buffer.alloc(headerLength);
    const headerRead = await fileHandle.read(headerBytes, 0, headerLength, fixed.length);
    requireCondition(headerRead.bytesRead === headerLength, 'ARCHIVE_TRUNCATED');
    let rawHeader;
    try {
      rawHeader = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      fail('ARCHIVE_HEADER_MALFORMED');
    }
    const header = parseEncryptedHeader(rawHeader);
    const prefix = Buffer.concat([fixed, headerBytes]);
    const ciphertextStart = prefix.length;
    const tagOffset = fileStats.size - ENCRYPTED_TAG_BYTES;
    requireCondition(tagOffset >= ciphertextStart, 'ARCHIVE_TRUNCATED');
    const authTag = Buffer.alloc(ENCRYPTED_TAG_BYTES);
    const tagRead = await fileHandle.read(authTag, 0, authTag.length, tagOffset);
    requireCondition(tagRead.bytesRead === authTag.length, 'ARCHIVE_TRUNCATED');
    await fileHandle.close();
    fileHandle = null;

    const key = scryptSync(passphrase, header.salt, 32, {
      ...SCRYPT_PARAMETERS,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv('aes-256-gcm', key, header.iv, {
      authTagLength: ENCRYPTED_TAG_BYTES,
    });
    key.fill(0);
    decipher.setAAD(prefix);
    decipher.setAuthTag(authTag);
    const encrypted = createReadStream(file, {
      start: ciphertextStart,
      end: tagOffset - 1,
    });
    return { stream: encrypted.pipe(decipher), contentType: header.contentType };
  } catch (error) {
    await fileHandle?.close().catch(() => {});
    if (error instanceof OperatorToolError) throw error;
    throw normalizeError(error, 'ARCHIVE_OPEN_OR_DECRYPT_FAILED');
  }
}

function parseTarOctal(buffer) {
  const value = buffer.toString('ascii').replaceAll('\0', '').trim();
  requireCondition(/^[0-7]+$/u.test(value), 'ARCHIVE_TAR_HEADER_MALFORMED');
  const parsed = Number.parseInt(value, 8);
  requireCondition(Number.isSafeInteger(parsed) && parsed >= 0, 'ARCHIVE_TAR_HEADER_MALFORMED');
  return parsed;
}

class TarVerifier {
  constructor(expectedEntries) {
    this.expectedEntries = expectedEntries;
    this.index = 0;
    this.pending = Buffer.alloc(0);
    this.current = null;
    this.paddingRemaining = 0;
    this.zeroBlocks = 0;
  }

  consume(input) {
    let chunk = input;
    while (chunk.length > 0) {
      if (this.current) {
        const length = Math.min(this.current.remaining, chunk.length);
        const part = chunk.subarray(0, length);
        this.current.hash.update(part);
        this.current.remaining -= length;
        chunk = chunk.subarray(length);
        if (this.current.remaining === 0) {
          requireCondition(
            this.current.hash.digest('hex') === this.current.expected.sha256,
            'ARCHIVE_ENTRY_HASH_MISMATCH',
          );
          this.paddingRemaining = (512 - (this.current.expected.size % 512)) % 512;
          this.current = null;
          this.index += 1;
        }
        continue;
      }

      if (this.paddingRemaining > 0) {
        const length = Math.min(this.paddingRemaining, chunk.length);
        requireCondition(
          chunk.subarray(0, length).every((value) => value === 0),
          'ARCHIVE_TAR_PADDING_MALFORMED',
        );
        this.paddingRemaining -= length;
        chunk = chunk.subarray(length);
        continue;
      }

      const combined = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
      if (combined.length < 512) {
        this.pending = Buffer.from(combined);
        return;
      }
      const header = combined.subarray(0, 512);
      chunk = combined.subarray(512);
      this.pending = Buffer.alloc(0);
      if (header.every((value) => value === 0)) {
        this.zeroBlocks += 1;
        continue;
      }
      requireCondition(this.zeroBlocks === 0, 'ARCHIVE_TAR_TRAILING_DATA');
      requireCondition(this.index < this.expectedEntries.length, 'ARCHIVE_TAR_EXTRA_ENTRY');
      const storedChecksum = parseTarOctal(header.subarray(148, 156));
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      const computedChecksum = checksumHeader.reduce((sum, value) => sum + value, 0);
      requireCondition(storedChecksum === computedChecksum, 'ARCHIVE_TAR_CHECKSUM_MISMATCH');
      requireCondition(header[156] === '0'.charCodeAt(0), 'ARCHIVE_TAR_ENTRY_TYPE_INVALID');
      requireCondition(
        header.subarray(157, 257).every((value) => value === 0),
        'ARCHIVE_TAR_LINK_TARGET_INVALID',
      );
      requireCondition(
        header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii')) &&
          header.subarray(345, 500).every((value) => value === 0),
        'ARCHIVE_TAR_HEADER_MALFORMED',
      );
      const nul = header.indexOf(0, 0);
      const name = header.subarray(0, nul === -1 || nul > 100 ? 100 : nul).toString('utf8');
      const size = parseTarOctal(header.subarray(124, 136));
      const expected = this.expectedEntries[this.index];
      requireCondition(
        name === expected.name && size === expected.size,
        'ARCHIVE_TAR_ENTRY_MISMATCH',
      );
      if (size === 0) {
        requireCondition(
          createHash('sha256').digest('hex') === expected.sha256,
          'ARCHIVE_ENTRY_HASH_MISMATCH',
        );
        this.index += 1;
      } else {
        this.current = { expected, remaining: size, hash: createHash('sha256') };
      }
    }
  }

  finish() {
    requireCondition(this.current === null, 'ARCHIVE_TAR_TRUNCATED_ENTRY');
    requireCondition(this.paddingRemaining === 0, 'ARCHIVE_TAR_TRUNCATED_PADDING');
    requireCondition(this.pending.length === 0, 'ARCHIVE_TAR_TRUNCATED_HEADER');
    requireCondition(this.index === this.expectedEntries.length, 'ARCHIVE_TAR_MISSING_ENTRY');
    requireCondition(this.zeroBlocks === 2, 'ARCHIVE_TAR_TERMINATOR_MALFORMED');
  }
}

export async function verifyEncryptedTar(
  file,
  passphrase,
  expectedEntries,
  expectedContentType = 'application/x-tar; profile=safetyhub-avatar-backup-v1',
) {
  const payload = await openEncryptedPayload(file, passphrase);
  requireCondition(payload.contentType === expectedContentType, 'ARCHIVE_CONTENT_TYPE_MISMATCH');
  const verifier = new TarVerifier(expectedEntries);
  try {
    for await (const chunk of payload.stream) verifier.consume(chunk);
    verifier.finish();
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    throw normalizeError(error, 'ARCHIVE_AUTHENTICATION_FAILED');
  }
}

export async function readEncryptedBuffer(file, passphrase, contentType, maxBytes = 1_048_576) {
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'ARCHIVE_READ_LIMIT_INVALID');
  const payload = await openEncryptedPayload(file, passphrase);
  requireCondition(payload.contentType === contentType, 'ARCHIVE_CONTENT_TYPE_MISMATCH');
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of payload.stream) {
      length += chunk.length;
      requireCondition(length <= maxBytes, 'ARCHIVE_READ_LIMIT_EXCEEDED');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    throw normalizeError(error, 'ARCHIVE_AUTHENTICATION_FAILED');
  }
  return Buffer.concat(chunks, length);
}

export async function decryptEncryptedPayloadToFile(
  file,
  outputFile,
  passphrase,
  contentType,
  expectedByteLength,
) {
  requireCondition(
    typeof outputFile === 'string' && path.isAbsolute(outputFile),
    'ARCHIVE_OUTPUT_PATH_INVALID',
  );
  requireCondition(
    Number.isSafeInteger(expectedByteLength) && expectedByteLength >= 0,
    'ARCHIVE_EXPECTED_SIZE_INVALID',
  );
  const payload = await openEncryptedPayload(file, passphrase);
  requireCondition(payload.contentType === contentType, 'ARCHIVE_CONTENT_TYPE_MISMATCH');
  let output;
  let length = 0;
  try {
    output = await open(outputFile, 'wx', 0o600);
    for await (const chunk of payload.stream) {
      length += chunk.length;
      requireCondition(length <= expectedByteLength, 'ARCHIVE_DECRYPTED_SIZE_MISMATCH');
      await writeFully(output, chunk);
    }
    requireCondition(length === expectedByteLength, 'ARCHIVE_DECRYPTED_SIZE_MISMATCH');
    await output.sync();
    await output.close();
    output = null;
    await chmod(outputFile, 0o600);
    return Object.freeze({ byteLength: length });
  } catch (error) {
    await output?.close().catch(() => {});
    await rm(outputFile, { force: true }).catch(() => {});
    if (error instanceof OperatorToolError) throw error;
    throw normalizeError(error, 'ARCHIVE_AUTHENTICATION_FAILED');
  }
}

async function verifyEncryptedBuffer(file, passphrase, contentType, expected) {
  const payload = await openEncryptedPayload(file, passphrase);
  requireCondition(payload.contentType === contentType, 'ARCHIVE_CONTENT_TYPE_MISMATCH');
  const hash = createHash('sha256');
  let length = 0;
  try {
    for await (const chunk of payload.stream) {
      hash.update(chunk);
      length += chunk.length;
    }
  } catch (error) {
    throw normalizeError(error, 'ARCHIVE_AUTHENTICATION_FAILED');
  }
  requireCondition(length === expected.length, 'MANIFEST_VERIFICATION_FAILED');
  requireCondition(
    hash.digest('hex') === createHash('sha256').update(expected).digest('hex'),
    'MANIFEST_VERIFICATION_FAILED',
  );
}

async function sha256File(file) {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch (error) {
    throw normalizeError(error, 'ARCHIVE_HASH_FAILED');
  }
  return hash.digest('hex');
}

async function readExactDownloadStream(stream, expectedByteSize) {
  requireCondition(
    stream !== null && typeof stream === 'object' && typeof stream.getReader === 'function',
    'STORAGE_DOWNLOAD_STREAM_MALFORMED',
  );
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      requireCondition(isPlainObject(result), 'STORAGE_DOWNLOAD_STREAM_MALFORMED');
      if (result.done === true) break;
      requireCondition(result.done === false, 'STORAGE_DOWNLOAD_STREAM_MALFORMED');
      requireCondition(result.value instanceof Uint8Array, 'STORAGE_DOWNLOAD_STREAM_MALFORMED');
      totalBytes += result.value.byteLength;
      if (totalBytes > expectedByteSize) {
        await reader.cancel().catch(() => {});
        fail('STORAGE_DOWNLOAD_SIZE_MISMATCH');
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof OperatorToolError) throw error;
    throw normalizeError(error, 'STORAGE_DOWNLOAD_READ_FAILED');
  } finally {
    reader.releaseLock?.();
  }
  requireCondition(totalBytes === expectedByteSize, 'STORAGE_DOWNLOAD_SIZE_MISMATCH');
  return Buffer.concat(chunks, totalBytes);
}

async function downloadObjectBytes(storage, key, expectedByteSize) {
  requireCondition(
    Number.isSafeInteger(expectedByteSize) &&
      expectedByteSize >= 1 &&
      expectedByteSize <= AVATAR_FILE_SIZE_LIMIT_BYTES,
    'STORAGE_DOWNLOAD_EXPECTED_SIZE_INVALID',
  );
  let request;
  try {
    request = storage.download(key, {}, { cache: 'no-store' });
  } catch (error) {
    throw normalizeError(error, 'STORAGE_DOWNLOAD_FAILED');
  }
  requireCondition(
    request !== null && typeof request === 'object' && typeof request.asStream === 'function',
    'STORAGE_DOWNLOAD_STREAM_UNSUPPORTED',
  );
  let response;
  try {
    response = await request.asStream();
  } catch (error) {
    throw normalizeError(error, 'STORAGE_DOWNLOAD_FAILED');
  }
  if (response?.error) throw normalizeError(response.error, 'STORAGE_DOWNLOAD_FAILED');
  return readExactDownloadStream(response?.data, expectedByteSize);
}

function privateVisibleMetadata(object) {
  return {
    storageMetadataId: object.id,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    lastAccessedAt: object.lastAccessedAt,
    listedByteLength: object.byteSize,
    etag: object.metadata?.eTag ?? object.metadata?.etag ?? null,
    mimeType: object.metadata?.mimetype ?? object.metadata?.contentType ?? null,
  };
}

function safeTimestamp(value) {
  return value.replace(/[:.]/gu, '-');
}

async function writePrivateJson(file, value) {
  try {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(file, 0o600);
  } catch {
    fail('PRIVATE_RECEIPT_WRITE_FAILED');
  }
}

export async function runAvatarBackup({
  client,
  config,
  archivePassphrase,
  outputDirectory,
  repositoryRoot,
  now = () => new Date(),
}) {
  requireCondition(client !== null && typeof client === 'object', 'CLIENT_REQUIRED');
  requireCondition(
    typeof archivePassphrase === 'string' && Buffer.byteLength(archivePassphrase, 'utf8') >= 32,
    'ARCHIVE_PASSPHRASE_TOO_SHORT',
  );
  const resolvedOutput = await validatePrivateOutputDirectory(outputDirectory, repositoryRoot);
  const capturedAtDate = now();
  requireCondition(
    capturedAtDate instanceof Date && Number.isFinite(capturedAtDate.getTime()),
    'CLOCK_INVALID',
  );

  const state = await collectVisibleState(client, config);
  const privateClassificationSalt = randomBytes(32);
  const classified = classifyPre700VisibleState(state, privateClassificationSalt, config.bucket);
  privateClassificationSalt.fill(0);
  const forensicBackup = config.backupBlockedVisibleObjects === true;
  if (!forensicBackup) {
    requireCondition(classified.blocked.length === 0, 'VISIBLE_METADATA_BLOCKERS_PRESENT');
  }
  const backupCandidates = [
    ...classified.eligible.map((object) => ({
      ...object,
      backupClassification: 'pre-700-eligible-for-backfill-candidate',
      blockerReasons: [],
    })),
    ...(forensicBackup
      ? classified.blocked.map(({ object, owner, reasons }) => ({
          ...object,
          userId: owner,
          backupClassification: 'visible-metadata-blocker-forensic-copy',
          blockerReasons: reasons,
        }))
      : []),
  ].sort((left, right) => left.key.localeCompare(right.key, 'en'));

  const runId = randomBytes(12).toString('hex');
  const runDirectoryName = `safetyhub-avatar-backup-${safeTimestamp(capturedAtDate.toISOString())}-${runId}`;
  const runDirectory = path.join(resolvedOutput, runDirectoryName);
  const archiveTemporary = path.join(runDirectory, 'avatars.tar.aes256gcm.incomplete');
  const archiveFile = path.join(runDirectory, 'avatars.tar.aes256gcm');
  const manifestTemporary = path.join(runDirectory, 'manifest.json.aes256gcm.incomplete');
  const manifestFile = path.join(runDirectory, 'manifest.json.aes256gcm');
  const receiptFile = path.join(runDirectory, 'receipt.json');
  let archiveWriter;
  let runDirectoryCreated = false;

  try {
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });
    runDirectoryCreated = true;
    await chmod(runDirectory, 0o700);
    archiveWriter = await EncryptedTarWriter.create(
      archiveTemporary,
      archivePassphrase,
      Math.floor(capturedAtDate.getTime() / 1_000),
    );
    const entries = [];
    const expectedArchiveEntries = [];
    const storage = client.storage.from(config.bucket);
    let totalBytes = 0;

    for (let index = 0; index < backupCandidates.length; index += 1) {
      const object = backupCandidates[index];
      const bytes = await downloadObjectBytes(storage, object.key, object.byteSize);
      try {
        requireCondition(bytes.length === object.byteSize, 'STORAGE_DOWNLOAD_SIZE_MISMATCH');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const archivePath = `objects/${String(index + 1).padStart(8, '0')}.webp`;
        await archiveWriter.addFile(archivePath, bytes);
        expectedArchiveEntries.push({ name: archivePath, size: bytes.length, sha256 });
        entries.push({
          archivePath,
          userId: object.userId,
          objectKey: object.key,
          classification: object.backupClassification,
          ...(object.blockerReasons.length > 0
            ? { visibleMetadataBlockerReasons: object.blockerReasons }
            : {}),
          visibleMetadata: privateVisibleMetadata(object),
          downloadedByteLength: bytes.length,
          sha256,
        });
        totalBytes += bytes.length;
      } finally {
        bytes.fill(0);
      }
    }

    const manifest = {
      manifestVersion: 1,
      kind: 'safetyhub-private-avatar-byte-backup',
      capturedAt: capturedAtDate.toISOString(),
      projectRef: config.productionProjectRef,
      bucket: config.bucket,
      classificationMode: config.classificationMode,
      coverage: {
        recursivelyPaginatedVisibleBucketMetadata: true,
        authUsersJoinedInMemory: true,
        profilesJoinedInMemory: true,
        accountControlsJoinedInMemory: true,
        readOnlyBucketConfigurationPreflightVerified: true,
        downloadedEligibleVisibleObjects: true,
        downloadedAllVisibleObjects: forensicBackup,
        verifiedListedByteLengthAndSha256: true,
        physicalBackendOrVersionInventoryPerformed: false,
        sourceConsistencyOrWriteDrainVerifiedByTool: false,
      },
      counts: {
        liveAuthUsers: state.auth.liveUsers.size,
        profiles: state.profiles.size,
        accountControls: state.accountControls.size,
        deletionPendingAccountControls: [...state.accountControls.values()].filter(
          (control) => control.deletionPending,
        ).length,
        visibleObjects: state.storage.objects.length,
        archivedObjects: entries.length,
        archivedBytes: totalBytes,
        visibleMetadataBlockerObjects: classified.blocked.length,
      },
      backendPhysicalOrVersionVerdict: 'not-assessed',
      verifiedBucketConfiguration: state.bucketConfiguration,
      entries,
      restoreNotes: [
        'Decrypt with the separately retained archive passphrase and the self-describing AES-256-GCM/scrypt header.',
        'The tar entry path is intentionally pseudonymous; use this private manifest for the exact user/object mapping.',
        'Recompute SHA-256 and byte length before any controlled restore.',
        'Visible metadata and downloaded bytes do not prove absence of hidden backend objects or versions.',
        'A stable recovery checkpoint requires an externally enforced write drain for the entire capture.',
      ],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    await archiveWriter.addFile('manifest.json', manifestBytes);
    expectedArchiveEntries.push({
      name: 'manifest.json',
      size: manifestBytes.length,
      sha256: manifestSha256,
    });
    await archiveWriter.finish();
    archiveWriter = null;

    await encryptBufferToFile(
      manifestTemporary,
      archivePassphrase,
      'application/json; profile=safetyhub-avatar-backup-manifest-v1',
      manifestBytes,
    );
    await verifyEncryptedTar(archiveTemporary, archivePassphrase, expectedArchiveEntries);
    await verifyEncryptedBuffer(
      manifestTemporary,
      archivePassphrase,
      'application/json; profile=safetyhub-avatar-backup-manifest-v1',
      manifestBytes,
    );
    manifestBytes.fill(0);

    const archiveSha256 = await sha256File(archiveTemporary);
    await rename(archiveTemporary, archiveFile);
    await rename(manifestTemporary, manifestFile);
    const receipt = {
      receiptVersion: 1,
      status: 'complete',
      capturedAt: capturedAtDate.toISOString(),
      projectRef: config.productionProjectRef,
      bucket: config.bucket,
      runDirectoryName,
      files: {
        encryptedArchive: path.basename(archiveFile),
        encryptedManifest: path.basename(manifestFile),
      },
      archivedObjects: entries.length,
      archivedBytes: totalBytes,
      archiveSha256,
      archiveVerified: true,
      manifestVerified: true,
      bucketConfigurationVerified: true,
      physicalBackendOrVersionInventoryPerformed: false,
      sourceConsistencyOrWriteDrainVerifiedByTool: false,
      backendPhysicalOrVersionVerdict: 'not-assessed',
    };
    await writePrivateJson(receiptFile, receipt);
    return receipt;
  } catch (error) {
    await archiveWriter?.abort().catch(() => {});
    if (runDirectoryCreated) {
      await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
    }
    if (error instanceof OperatorToolError) throw error;
    throw normalizeError(error, 'BACKUP_FAILED');
  }
}

export async function writeInventoryReport(file, report, repositoryRoot) {
  requireCondition(
    typeof file === 'string' && path.isAbsolute(file),
    'INVENTORY_OUTPUT_PATH_MUST_BE_ABSOLUTE',
  );
  const resolvedRepository = await realpath(repositoryRoot).catch(() =>
    fail('REPOSITORY_PATH_NOT_DIRECTORY'),
  );
  const resolvedOutputParent = await realpath(path.dirname(file)).catch(() =>
    fail('INVENTORY_OUTPUT_PARENT_UNAVAILABLE'),
  );
  requireCondition(
    insideOrEqual(resolvedRepository, resolvedOutputParent),
    'INVENTORY_OUTPUT_OUTSIDE_REPOSITORY',
  );
  const finalPath = path.join(resolvedOutputParent, path.basename(file));
  try {
    await writeFile(finalPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    fail('INVENTORY_OUTPUT_WRITE_FAILED');
  }
}

export function parseStrictArguments(argv, specification) {
  requireCondition(Array.isArray(argv), 'CLI_ARGUMENTS_INVALID');
  const allowed = new Set(specification);
  const parsed = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    requireCondition(allowed.has(name), 'CLI_UNKNOWN_ARGUMENT');
    requireCondition(value !== undefined && !value.startsWith('--'), 'CLI_ARGUMENT_VALUE_REQUIRED');
    requireCondition(parsed[name] === undefined, 'CLI_DUPLICATE_ARGUMENT');
    parsed[name] = value;
  }
  return parsed;
}
