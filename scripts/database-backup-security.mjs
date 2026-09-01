import { createHash, X509Certificate } from 'node:crypto';
import { open, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { checkServerIdentity } from 'node:tls';

const LINKED_DATABASE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+supabase[.](?:com|co)$/iu;
const LINKED_DATABASE_USER = /^cli_login_/u;
const DATABASE_BACKUP_KIND = 'safetyhub-database-backup-v1';
const DATABASE_BACKUP_CIPHER = 'aes-256-gcm';
const DATABASE_BACKUP_MAGIC_BYTES = Buffer.byteLength('SAFETYHUB-DB-BACKUP-V1\0');
const DATABASE_BACKUP_ENVELOPE_OVERHEAD = DATABASE_BACKUP_MAGIC_BYTES + 12 + 16;
const DATABASE_BACKUP_RECEIPT_MAX_BYTES = 64 * 1024;
const DATABASE_BACKUP_MAX_ARTIFACTS = 32;
const DATABASE_BACKUP_HASH = /^[0-9a-f]{64}$/u;
const DATABASE_BACKUP_ARTIFACT_SUFFIX = /[.](?:sql|dump)[.]aes256gcm$/iu;
const WINDOWS_RESERVED_STEM =
  /^(?:con|prn|aux|nul|clock[$]|conin[$]|conout[$]|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/iu;
const PORTABLE_WRAPPED_KEY_FILE = 'database-backup.key.recovery.aes256gcm';
const PORTABLE_RECOVERY_KEY_FORMAT = 'SAFETYHUB-RECOVERY-KEY-V1';
const WINDOWS_DPAPI_KEY_PROTECTION = 'windows-dpapi-current-user';
const PORTABLE_KEY_PROTECTION = 'portable-recovery-key-aes-256-gcm';
const POSTGRES_SSL_ROOT_CERT_MAX_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const loadedSslRootCertificates = new WeakSet();

function decodeShellValue(rawValue) {
  const value = rawValue.trim().replace(/[;]$/u, '');
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function invalidLinkedCredentials() {
  throw new Error('Temporary linked database credentials were invalid.');
}

function validateLinkedConnection(connection) {
  if (
    !connection ||
    typeof connection.PGHOST !== 'string' ||
    connection.PGHOST.length > 253 ||
    !LINKED_DATABASE_HOST.test(connection.PGHOST) ||
    typeof connection.PGUSER !== 'string' ||
    !LINKED_DATABASE_USER.test(connection.PGUSER) ||
    connection.PGUSER.length === 'cli_login_'.length ||
    connection.PGUSER.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(connection.PGUSER) ||
    typeof connection.PGPASSWORD !== 'string' ||
    connection.PGPASSWORD.length === 0 ||
    connection.PGPASSWORD.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(connection.PGPASSWORD) ||
    typeof connection.PGDATABASE !== 'string' ||
    connection.PGDATABASE.length === 0 ||
    connection.PGDATABASE.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(connection.PGDATABASE) ||
    !/^[0-9]{1,5}$/u.test(connection.PGPORT)
  ) {
    invalidLinkedCredentials();
  }
  const port = Number(connection.PGPORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) invalidLinkedCredentials();
  return connection;
}

function connectionFromUri(output) {
  const uri = output.match(/postgres(?:ql)?:\/\/[^\s'";]+/iu)?.[0];
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    return {
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || '5432',
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//u, '')) || 'postgres',
    };
  } catch {
    return null;
  }
}

export function parseLinkedPostgresConnection(output, { allowUri = false } = {}) {
  if (typeof output !== 'string' || output.length > 16 * 1024 * 1024) {
    invalidLinkedCredentials();
  }
  const connection = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:export\s+|set\s+)?(PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)=(.+)$/iu,
    );
    if (match) connection[match[1].toUpperCase()] = decodeShellValue(match[2]);
  }
  const candidate =
    connection.PGHOST && connection.PGUSER && connection.PGPASSWORD
      ? {
          ...connection,
          PGPORT: connection.PGPORT || '5432',
          PGDATABASE: connection.PGDATABASE || 'postgres',
        }
      : allowUri
        ? connectionFromUri(output)
        : null;
  if (!candidate) return null;
  return validateLinkedConnection(candidate);
}

export async function loadPostgresSslRootCertificate(
  certificateFile,
  { expectedSha256, now = () => new Date() } = {},
) {
  if (typeof certificateFile !== 'string' || !path.isAbsolute(certificateFile)) {
    throw new Error('PostgreSQL SSL root certificate path must be absolute.');
  }
  if (expectedSha256 !== undefined && !SHA256_HEX.test(expectedSha256)) {
    throw new Error('PostgreSQL SSL root certificate SHA-256 pin is invalid.');
  }
  let stats;
  let bytes;
  let physicalPath;
  try {
    stats = await lstat(certificateFile);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('PostgreSQL SSL root certificate must be a regular file.');
    }
    if (stats.size < 256 || stats.size > POSTGRES_SSL_ROOT_CERT_MAX_BYTES) {
      throw new Error('PostgreSQL SSL root certificate size is invalid.');
    }
    [bytes, physicalPath] = await Promise.all([
      readFile(certificateFile),
      realpath(certificateFile),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PostgreSQL SSL root certificate')) {
      throw error;
    }
    throw new Error('PostgreSQL SSL root certificate is unavailable.');
  }
  try {
    const pem = bytes.toString('utf8');
    const certificates = pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu,
    );
    if (
      !certificates ||
      certificates.length !== 1 ||
      pem.replace(certificates[0], '').trim() !== ''
    ) {
      throw new Error('PostgreSQL SSL root certificate PEM is invalid.');
    }
    let certificate;
    try {
      certificate = new X509Certificate(certificates[0]);
    } catch {
      throw new Error('PostgreSQL SSL root certificate PEM is invalid.');
    }
    if (certificate.ca !== true) {
      throw new Error('PostgreSQL SSL root certificate is not a CA certificate.');
    }
    const checkedAt = now();
    if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
      throw new Error('PostgreSQL SSL root certificate validation clock is invalid.');
    }
    const validFrom = new Date(certificate.validFrom);
    const validTo = new Date(certificate.validTo);
    if (
      !Number.isFinite(validFrom.getTime()) ||
      !Number.isFinite(validTo.getTime()) ||
      checkedAt < validFrom ||
      checkedAt > validTo
    ) {
      throw new Error('PostgreSQL SSL root certificate is outside its validity period.');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new Error('PostgreSQL SSL root certificate SHA-256 pin mismatch.');
    }
    const result = Object.freeze({
      physicalPath,
      pem: certificates[0],
      sha256,
      fingerprint256: certificate.fingerprint256,
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
    });
    loadedSslRootCertificates.add(result);
    return result;
  } finally {
    bytes.fill(0);
  }
}

function requireLoadedSslRootCertificate(value) {
  if (!value || typeof value !== 'object' || !loadedSslRootCertificates.has(value)) {
    throw new Error('A validated PostgreSQL SSL root certificate is required.');
  }
  return value;
}

export function linkedPostgresClientOptions(connection, options = {}) {
  validateLinkedConnection(connection);
  const { sslRootCertificate, ...clientOptions } = options;
  const certificate = requireLoadedSslRootCertificate(sslRootCertificate);
  return {
    ...clientOptions,
    host: connection.PGHOST,
    port: Number(connection.PGPORT),
    user: connection.PGUSER,
    password: connection.PGPASSWORD,
    database: connection.PGDATABASE,
    ssl: {
      ca: certificate.pem,
      checkServerIdentity,
      rejectUnauthorized: true,
      servername: connection.PGHOST,
    },
  };
}

export function linkedPostgresEnvironment(
  connection,
  sslRootCertificate,
  inheritedEnvironment = process.env,
) {
  validateLinkedConnection(connection);
  const certificate = requireLoadedSslRootCertificate(sslRootCertificate);
  const environment = Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(([name]) => !/^PG/iu.test(name)),
  );
  return {
    ...environment,
    PGHOST: connection.PGHOST,
    PGPORT: connection.PGPORT,
    PGUSER: connection.PGUSER,
    PGPASSWORD: connection.PGPASSWORD,
    PGDATABASE: connection.PGDATABASE,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: certificate.physicalPath,
  };
}

export function redactLinkedPostgresError(error, connection) {
  let message = error instanceof Error ? error.message : 'Unknown linked database error';
  const password = connection?.PGPASSWORD;
  if (typeof password === 'string' && password.length > 0) {
    message = message.replaceAll(password, '[redacted]');
    const encodedPassword = encodeURIComponent(password);
    if (encodedPassword !== password) message = message.replaceAll(encodedPassword, '[redacted]');
  }
  return message;
}

export function clearLinkedPostgresConnection(connection) {
  if (!connection || typeof connection !== 'object') return;
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
    if (Object.hasOwn(connection, name)) connection[name] = '';
  }
}

function invalidReceipt() {
  throw new Error('Database backup receipt is invalid.');
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safePortableBasename(value) {
  const windowsStem = typeof value === 'string' ? value.split('.')[0].replace(/[. ]+$/u, '') : '';
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f<>:"|?*]/u.test(value) ||
    /[. ]$/u.test(value) ||
    WINDOWS_RESERVED_STEM.test(windowsStem) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.basename(value) !== value ||
    path.win32.basename(value) !== value
  ) {
    invalidReceipt();
  }
  return value;
}

export function databaseBackupArtifactName(sourcePath) {
  try {
    const sourceName = safePortableBasename(path.basename(sourcePath));
    if (!/[.](?:sql|dump)$/iu.test(sourceName)) invalidReceipt();
    return safePortableBasename(`${sourceName}.aes256gcm`);
  } catch {
    throw new Error('Plaintext dump filename must be a safe .sql or .dump basename.');
  }
}

function windowsFilenameKey(value) {
  return value.normalize('NFC').toUpperCase();
}

function validSha256(value) {
  return typeof value === 'string' && DATABASE_BACKUP_HASH.test(value);
}

function validByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function validateDatabaseBackupReceipt(value) {
  if (
    !hasExactKeys(value, [
      'kind',
      'createdAt',
      'cipher',
      'keyProtection',
      'artifacts',
      'portableRecovery',
    ]) ||
    value.kind !== DATABASE_BACKUP_KIND ||
    value.cipher !== DATABASE_BACKUP_CIPHER ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 32 ||
    !Array.isArray(value.keyProtection) ||
    value.keyProtection.length !== 2 ||
    value.keyProtection[0] !== WINDOWS_DPAPI_KEY_PROTECTION ||
    value.keyProtection[1] !== PORTABLE_KEY_PROTECTION ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length > DATABASE_BACKUP_MAX_ARTIFACTS
  ) {
    invalidReceipt();
  }
  try {
    if (new Date(value.createdAt).toISOString() !== value.createdAt) invalidReceipt();
  } catch {
    invalidReceipt();
  }

  const encryptedNames = new Set();
  const outputNames = new Set();
  const validatedArtifacts = [];
  for (const artifact of value.artifacts) {
    if (
      !hasExactKeys(artifact, [
        'name',
        'plaintextBytes',
        'plaintextSha256',
        'encryptedBytes',
        'encryptedSha256',
      ]) ||
      typeof artifact.name !== 'string' ||
      !DATABASE_BACKUP_ARTIFACT_SUFFIX.test(artifact.name) ||
      !validByteCount(artifact.plaintextBytes) ||
      artifact.plaintextBytes < 128 ||
      !validByteCount(artifact.encryptedBytes) ||
      artifact.encryptedBytes !== artifact.plaintextBytes + DATABASE_BACKUP_ENVELOPE_OVERHEAD ||
      !validSha256(artifact.plaintextSha256) ||
      !validSha256(artifact.encryptedSha256)
    ) {
      invalidReceipt();
    }
    safePortableBasename(artifact.name);
    const outputName = artifact.name.replace(/[.]aes256gcm$/iu, '');
    safePortableBasename(outputName);
    const encryptedKey = windowsFilenameKey(artifact.name);
    const outputKey = windowsFilenameKey(outputName);
    if (encryptedNames.has(encryptedKey) || outputNames.has(outputKey)) invalidReceipt();
    encryptedNames.add(encryptedKey);
    outputNames.add(outputKey);
    validatedArtifacts.push({ ...artifact, outputName });
  }

  if (
    !hasExactKeys(value.portableRecovery, [
      'algorithm',
      'wrappedKeyFile',
      'encryptedSha256',
      'recoveryKeyFormat',
    ]) ||
    value.portableRecovery.algorithm !== DATABASE_BACKUP_CIPHER ||
    value.portableRecovery.wrappedKeyFile !== PORTABLE_WRAPPED_KEY_FILE ||
    !validSha256(value.portableRecovery.encryptedSha256) ||
    value.portableRecovery.recoveryKeyFormat !== PORTABLE_RECOVERY_KEY_FORMAT
  ) {
    invalidReceipt();
  }
  safePortableBasename(value.portableRecovery.wrappedKeyFile);
  return {
    ...value,
    artifacts: validatedArtifacts,
    portableRecovery: { ...value.portableRecovery },
  };
}

export async function readDatabaseBackupReceipt(receiptPath) {
  let handle;
  try {
    const receiptStats = await lstat(receiptPath);
    if (!receiptStats.isFile() || receiptStats.isSymbolicLink()) invalidReceipt();
    handle = await open(receiptPath, 'r');
    const bytes = Buffer.alloc(DATABASE_BACKUP_RECEIPT_MAX_BYTES + 1);
    let receiptBytes = 0;
    while (receiptBytes < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        receiptBytes,
        bytes.byteLength - receiptBytes,
        receiptBytes,
      );
      if (result.bytesRead === 0) break;
      receiptBytes += result.bytesRead;
    }
    if (receiptBytes === 0 || receiptBytes > DATABASE_BACKUP_RECEIPT_MAX_BYTES) invalidReceipt();
    const serialized = bytes.subarray(0, receiptBytes).toString('utf8');
    if (serialized.includes('\ufffd')) invalidReceipt();
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      invalidReceipt();
    }
    return validateDatabaseBackupReceipt(parsed);
  } catch (error) {
    if (error instanceof Error && error.message === 'Database backup receipt is invalid.') {
      throw error;
    }
    invalidReceipt();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function pathComparisonKey(value) {
  const normalized = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? normalized.toUpperCase() : normalized;
}

function pathIsInside(directory, candidate) {
  const relative = path.relative(pathComparisonKey(directory), pathComparisonKey(candidate));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function inspectPhysicalPath(targetPath, expectation, label) {
  const absolutePath = path.resolve(targetPath);
  const missingSegments = [];
  let existingPath = absolutePath;
  let existingStats;
  for (;;) {
    try {
      existingStats = await lstat(existingPath);
      break;
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        throw new Error(`${label} could not be inspected.`);
      }
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw new Error(`${label} could not be inspected.`);
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
  }
  let existingPhysicalPath;
  try {
    existingPhysicalPath = await realpath(existingPath);
  } catch {
    throw new Error(`${label} could not be inspected.`);
  }
  const exists = missingSegments.length === 0;
  if (expectation === 'absent' && exists) throw new Error(`${label} must not already exist.`);
  if (expectation !== 'absent' && !exists) throw new Error(`${label} does not exist.`);
  if (exists) {
    if (existingStats.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link or junction.`);
    }
    let refreshedStats;
    let refreshedPhysicalPath;
    try {
      [refreshedStats, refreshedPhysicalPath] = await Promise.all([
        lstat(absolutePath),
        realpath(absolutePath),
      ]);
    } catch {
      throw new Error(`${label} changed during inspection.`);
    }
    if (
      refreshedStats.isSymbolicLink() ||
      refreshedStats.dev !== existingStats.dev ||
      refreshedStats.ino !== existingStats.ino ||
      pathComparisonKey(refreshedPhysicalPath) !== pathComparisonKey(existingPhysicalPath)
    ) {
      throw new Error(`${label} changed during inspection.`);
    }
    existingStats = refreshedStats;
    existingPhysicalPath = refreshedPhysicalPath;
  } else {
    try {
      await lstat(absolutePath);
      throw new Error(`${label} changed during inspection.`);
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
    }
  }
  if (expectation === 'file' && !existingStats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  if (expectation === 'directory' && !existingStats.isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
  return {
    absolutePath,
    exists,
    physicalPath: path.resolve(existingPhysicalPath, ...missingSegments),
  };
}

export async function assertPhysicalPathRelationship({
  directoryPath,
  candidatePath,
  relationship,
  directoryExpectation,
  candidateExpectation,
  directoryLabel = 'Directory',
  candidateLabel = 'Path',
  expectedDirectoryPhysicalPath,
  expectedCandidatePhysicalPath,
  relationshipError,
}) {
  if (!['inside', 'outside'].includes(relationship)) {
    throw new Error('Unsupported physical path relationship.');
  }
  const [directory, candidate] = await Promise.all([
    inspectPhysicalPath(directoryPath, directoryExpectation, directoryLabel),
    inspectPhysicalPath(candidatePath, candidateExpectation, candidateLabel),
  ]);
  if (
    expectedDirectoryPhysicalPath &&
    pathComparisonKey(directory.physicalPath) !== pathComparisonKey(expectedDirectoryPhysicalPath)
  ) {
    throw new Error(`${directoryLabel} changed during the operation.`);
  }
  if (
    expectedCandidatePhysicalPath &&
    pathComparisonKey(candidate.physicalPath) !== pathComparisonKey(expectedCandidatePhysicalPath)
  ) {
    throw new Error(`${candidateLabel} changed during the operation.`);
  }
  const inside = pathIsInside(directory.physicalPath, candidate.physicalPath);
  if ((relationship === 'inside' && !inside) || (relationship === 'outside' && inside)) {
    throw new Error(relationshipError || `${candidateLabel} has an unsafe filesystem location.`);
  }
  if (
    relationship === 'inside' &&
    pathComparisonKey(directory.physicalPath) === pathComparisonKey(candidate.physicalPath)
  ) {
    throw new Error(relationshipError || `${candidateLabel} has an unsafe filesystem location.`);
  }
  return { directory, candidate };
}
