import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  PROTECTED_PROJECT_REFS,
  assertDisposableProjectMarker,
  assertLoadTestTarget,
} from './load-test-safety.mjs';
import {
  ProductionOperatorError,
  assertCurrentProductionProjectRef,
  assertProjectRef,
  readOperatorEnvironmentFile,
} from './production-operator-safety.mjs';
import {
  OperatorToolError,
  createBoundedFetch,
  decryptEncryptedPayloadToFile,
  readServiceCredential,
} from './storage-operator-tools.mjs';
import {
  STORAGE_BYTE_BACKUP_TAR_CONTENT_TYPE,
  readVerifiedStorageByteBackupForRestore,
  validateStorageBackupRequest,
} from './storage-byte-backup-tools.mjs';

const USAGE =
  'Usage: --backup <absolute-encrypted-run-directory> --expected-source-project-ref <current-production-ref> --allow-bucket <each-required-bucket> --target-project-ref <disposable-ref> --confirm-target-project-ref <same-disposable-ref> --confirm-disposable-project "DISPOSABLE SECURITY TEST" --env-file <absolute-target-secret-env-file> --recovery-key-file <absolute-portable-key-file> [--request-timeout-ms <1000-120000>]';
const RECOVERY_KEY_PREFIX = 'SAFETYHUB-STORAGE-RECOVERY-KEY-V1:';
const PAGE_SIZE = 100;
const MAX_LIST_REQUESTS = 10_000_000;
const MAX_DIRECTORIES = 1_000_000;
const MAX_OBJECTS = 5_000_000;

function fail(code) {
  throw new OperatorToolError(code);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function parseInteger(value, minimum, maximum, code) {
  requireCondition(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value), code);
  const parsed = Number(value);
  requireCondition(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum, code);
  return parsed;
}

export function parseArguments(argv) {
  const allowed = new Set([
    '--backup',
    '--expected-source-project-ref',
    '--allow-bucket',
    '--target-project-ref',
    '--confirm-target-project-ref',
    '--confirm-disposable-project',
    '--env-file',
    '--recovery-key-file',
    '--request-timeout-ms',
  ]);
  const values = Object.create(null);
  values['--allow-bucket'] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    requireCondition(allowed.has(name), 'STORAGE_RESTORE_CLI_UNKNOWN_ARGUMENT');
    requireCondition(
      typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      'STORAGE_RESTORE_CLI_ARGUMENT_VALUE_REQUIRED',
    );
    if (name === '--allow-bucket') {
      values[name].push(value);
      continue;
    }
    requireCondition(values[name] === undefined, 'STORAGE_RESTORE_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
  }
  for (const required of [
    '--backup',
    '--expected-source-project-ref',
    '--target-project-ref',
    '--confirm-target-project-ref',
    '--confirm-disposable-project',
    '--env-file',
    '--recovery-key-file',
  ]) {
    requireCondition(
      values[required] !== undefined,
      'STORAGE_RESTORE_CLI_REQUIRED_ARGUMENT_MISSING',
    );
  }
  requireCondition(
    values['--allow-bucket'].length > 0,
    'STORAGE_RESTORE_CLI_REQUIRED_ARGUMENT_MISSING',
  );
  requireCondition(path.isAbsolute(values['--backup']), 'STORAGE_RESTORE_BACKUP_PATH_INVALID');
  requireCondition(path.isAbsolute(values['--env-file']), 'STORAGE_RESTORE_ENV_FILE_PATH_INVALID');
  requireCondition(
    path.isAbsolute(values['--recovery-key-file']),
    'STORAGE_RESTORE_RECOVERY_KEY_PATH_INVALID',
  );

  const sourceProjectRef = assertCurrentProductionProjectRef(
    values['--expected-source-project-ref'],
  );
  const targetProjectRef = assertProjectRef(
    values['--target-project-ref'],
    'STORAGE_RESTORE_TARGET_REF_INVALID',
  );
  try {
    assertLoadTestTarget({
      url: `https://${targetProjectRef}.supabase.co`,
      disposableRef: targetProjectRef,
      confirmation: values['--confirm-target-project-ref'],
      marker: values['--confirm-disposable-project'],
    });
  } catch {
    fail('STORAGE_RESTORE_DISPOSABLE_TARGET_REQUIRED');
  }
  requireCondition(
    !PROTECTED_PROJECT_REFS.includes(targetProjectRef),
    'STORAGE_RESTORE_PRODUCTION_TARGET_DENIED',
  );
  const request = validateStorageBackupRequest({
    expectedProjectRef: sourceProjectRef,
    buckets: values['--allow-bucket'],
  });

  return Object.freeze({
    backupDirectory: path.resolve(values['--backup']),
    sourceProjectRef,
    buckets: request.buckets,
    targetProjectRef,
    targetConfirmation: values['--confirm-target-project-ref'],
    disposableMarker: values['--confirm-disposable-project'],
    environmentFile: values['--env-file'],
    recoveryKeyFile: values['--recovery-key-file'],
    requestTimeoutMs:
      values['--request-timeout-ms'] === undefined
        ? 120_000
        : parseInteger(
            values['--request-timeout-ms'],
            1_000,
            120_000,
            'STORAGE_RESTORE_TIMEOUT_INVALID',
          ),
  });
}

async function requirePhysicalRegularFile(file, maximumBytes, code) {
  let stats;
  try {
    stats = await lstat(file);
    requireCondition(stats.isFile() && !stats.isSymbolicLink(), code);
    requireCondition(stats.size > 0 && stats.size <= maximumBytes, code);
    return await realpath(file);
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    fail(code);
  }
}

async function requirePhysicalBackupDirectory(directory) {
  let stats;
  try {
    stats = await lstat(directory);
    requireCondition(
      stats.isDirectory() && !stats.isSymbolicLink(),
      'STORAGE_RESTORE_BACKUP_INVALID',
    );
    return await realpath(directory);
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    fail('STORAGE_RESTORE_BACKUP_INVALID');
  }
}

export async function readPortableRecoveryKey(file) {
  const physicalFile = await requirePhysicalRegularFile(
    path.resolve(file),
    256,
    'STORAGE_RESTORE_RECOVERY_KEY_INVALID',
  );
  let bytes;
  try {
    bytes = await readFile(physicalFile);
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0a) {
      end -= 1;
      if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
    }
    const serialized = bytes.subarray(0, end).toString('utf8');
    requireCondition(
      serialized.startsWith(RECOVERY_KEY_PREFIX) &&
        /^[A-Za-z0-9+/]{64}$/u.test(serialized.slice(RECOVERY_KEY_PREFIX.length)),
      'STORAGE_RESTORE_RECOVERY_KEY_INVALID',
    );
    return serialized.slice(RECOVERY_KEY_PREFIX.length);
  } finally {
    bytes?.fill(0);
  }
}

function expectedTarByteLength(restoreDetails) {
  const expectedEntries = [...restoreDetails.entries, restoreDetails.embeddedManifest];
  let total = 1_024;
  for (const entry of expectedEntries) {
    const size = entry.size ?? entry.downloadedByteLength;
    requireCondition(
      Number.isSafeInteger(size) && size >= 0,
      'STORAGE_RESTORE_ARCHIVE_SIZE_INVALID',
    );
    const padding = (512 - (size % 512)) % 512;
    total += 512 + size + padding;
    requireCondition(Number.isSafeInteger(total), 'STORAGE_RESTORE_ARCHIVE_SIZE_INVALID');
  }
  return total;
}

async function runTarExtraction(tarFile, destination) {
  // GNU tar reads `host:path` in a path argument as a remote archive, so a
  // Windows absolute path fails with "Cannot connect to C: resolve failed" and
  // an absolute `-C` target is mangled the same way. Extracting from inside the
  // destination and naming the archive relatively keeps one command portable
  // across GNU tar, bsdtar and macOS tar.
  const relativeArchive = path.relative(destination, tarFile).split(path.sep).join('/');
  requireCondition(
    relativeArchive.length > 0 && !path.isAbsolute(relativeArchive) && !/^[A-Za-z]:/u.test(relativeArchive),
    'STORAGE_RESTORE_TAR_EXTRACTION_FAILED',
  );
  let diagnostics = '';
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', relativeArchive], {
      cwd: destination,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 10 * 60 * 1_000,
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (diagnostics.length < 2_000) diagnostics += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal === null ? code : null));
  }).catch(() => null);
  if (exitCode !== 0 && diagnostics.trim()) {
    // Without this, an extraction failure gave the operator nothing to act on.
    console.error(`tar: ${diagnostics.trim().slice(0, 500)}`);
  }
  requireCondition(exitCode === 0, 'STORAGE_RESTORE_TAR_EXTRACTION_FAILED');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      byteLength += chunk.length;
      hash.update(chunk);
    }
  } catch {
    fail('STORAGE_RESTORE_EXTRACTED_FILE_INVALID');
  }
  return { byteLength, sha256: hash.digest('hex') };
}

async function validateExtractedArchive(extractionDirectory, restoreDetails) {
  const expectedRootEntries =
    restoreDetails.entries.length === 0 ? ['manifest.json'] : ['manifest.json', 'objects'];
  let rootEntries;
  try {
    rootEntries = (await readdir(extractionDirectory)).sort(compareUtf8);
  } catch {
    fail('STORAGE_RESTORE_EXTRACTED_FILE_INVALID');
  }
  requireCondition(
    JSON.stringify(rootEntries) === JSON.stringify(expectedRootEntries),
    'STORAGE_RESTORE_EXTRACTED_INVENTORY_INVALID',
  );
  if (restoreDetails.entries.length > 0) {
    const objectNames = (await readdir(path.join(extractionDirectory, 'objects'))).sort(
      compareUtf8,
    );
    const expectedNames = restoreDetails.entries
      .map((entry) => path.basename(entry.archivePath))
      .sort(compareUtf8);
    requireCondition(
      JSON.stringify(objectNames) === JSON.stringify(expectedNames),
      'STORAGE_RESTORE_EXTRACTED_INVENTORY_INVALID',
    );
  }
  for (const entry of [...restoreDetails.entries, restoreDetails.embeddedManifest]) {
    const file = path.join(extractionDirectory, ...(entry.archivePath?.split('/') ?? [entry.name]));
    const stats = await lstat(file).catch(() => null);
    requireCondition(
      stats?.isFile() && !stats.isSymbolicLink(),
      'STORAGE_RESTORE_EXTRACTED_FILE_INVALID',
    );
    const actual = await sha256File(file);
    const expectedSize = entry.size ?? entry.downloadedByteLength;
    requireCondition(
      actual.byteLength === expectedSize && actual.sha256 === entry.sha256,
      'STORAGE_RESTORE_EXTRACTED_FILE_INVALID',
    );
  }
}

export async function materializeVerifiedStorageBackup({
  verifiedBackup,
  archivePassphrase,
  temporaryDirectory,
}) {
  const restoreDetails = verifiedBackup?.restoreDetails;
  requireCondition(
    restoreDetails && typeof restoreDetails === 'object',
    'STORAGE_RESTORE_DETAILS_INVALID',
  );
  const tarFile = path.join(temporaryDirectory, 'verified-storage.tar');
  const extractionDirectory = path.join(temporaryDirectory, 'extracted');
  await mkdir(extractionDirectory, { recursive: false, mode: 0o700 });
  await chmod(extractionDirectory, 0o700);
  await decryptEncryptedPayloadToFile(
    restoreDetails.archiveFile,
    tarFile,
    archivePassphrase,
    STORAGE_BYTE_BACKUP_TAR_CONTENT_TYPE,
    expectedTarByteLength(restoreDetails),
  );
  try {
    await runTarExtraction(tarFile, extractionDirectory);
    await validateExtractedArchive(extractionDirectory, restoreDetails);
  } finally {
    await rm(tarFile, { force: true }).catch(() => {});
  }
  return Object.freeze({ extractionDirectory });
}

function normalizeTargetBucketConfiguration(bucket, data) {
  requireCondition(
    data && typeof data === 'object' && !Array.isArray(data),
    'STORAGE_RESTORE_BUCKET_INVALID',
  );
  requireCondition(data.id === bucket && data.name === bucket, 'STORAGE_RESTORE_BUCKET_INVALID');
  requireCondition(typeof data.public === 'boolean', 'STORAGE_RESTORE_BUCKET_INVALID');
  requireCondition(
    data.file_size_limit === null ||
      (Number.isSafeInteger(data.file_size_limit) && data.file_size_limit >= 0),
    'STORAGE_RESTORE_BUCKET_INVALID',
  );
  requireCondition(
    data.allowed_mime_types === null ||
      (Array.isArray(data.allowed_mime_types) &&
        data.allowed_mime_types.every((value) => typeof value === 'string')),
    'STORAGE_RESTORE_BUCKET_INVALID',
  );
  return {
    id: bucket,
    public: data.public,
    fileSizeLimitBytes: data.file_size_limit,
    allowedMimeTypes: data.allowed_mime_types === null ? null : [...data.allowed_mime_types],
  };
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

async function listTargetObjects(client, bucket) {
  const storage = client.storage.from(bucket);
  const directories = [''];
  const seenDirectories = new Set(directories);
  const seenObjects = new Set();
  const objects = [];
  let requestCount = 0;
  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    requireCondition(directoryIndex < MAX_DIRECTORIES, 'STORAGE_RESTORE_TARGET_INVENTORY_LIMIT');
    const prefix = directories[directoryIndex];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      requestCount += 1;
      requireCondition(requestCount <= MAX_LIST_REQUESTS, 'STORAGE_RESTORE_TARGET_INVENTORY_LIMIT');
      let response;
      try {
        response = await storage.list(prefix, {
          limit: PAGE_SIZE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        });
      } catch {
        fail('STORAGE_RESTORE_TARGET_INVENTORY_FAILED');
      }
      if (response?.error) fail('STORAGE_RESTORE_TARGET_INVENTORY_FAILED');
      requireCondition(Array.isArray(response?.data), 'STORAGE_RESTORE_TARGET_INVENTORY_INVALID');
      for (const item of response.data) {
        requireCondition(
          item && typeof item === 'object' && !Array.isArray(item) && safePathComponent(item.name),
          'STORAGE_RESTORE_TARGET_INVENTORY_INVALID',
        );
        const key = prefix === '' ? item.name : `${prefix}/${item.name}`;
        if (item.id === null) {
          requireCondition(item.metadata === null, 'STORAGE_RESTORE_TARGET_INVENTORY_INVALID');
          requireCondition(!seenDirectories.has(key), 'STORAGE_RESTORE_TARGET_INVENTORY_INVALID');
          seenDirectories.add(key);
          directories.push(key);
        } else {
          requireCondition(!seenObjects.has(key), 'STORAGE_RESTORE_TARGET_INVENTORY_INVALID');
          seenObjects.add(key);
          objects.push(key);
          requireCondition(objects.length <= MAX_OBJECTS, 'STORAGE_RESTORE_TARGET_INVENTORY_LIMIT');
        }
      }
      if (response.data.length < PAGE_SIZE) break;
    }
  }
  return objects.sort(compareUtf8);
}

export async function inspectDisposableStorageTarget(client, buckets, expectedConfigurations) {
  let inventory;
  try {
    inventory = await client.storage.listBuckets({ limit: 100, offset: 0 });
  } catch {
    fail('STORAGE_RESTORE_BUCKET_INVENTORY_FAILED');
  }
  if (inventory?.error) fail('STORAGE_RESTORE_BUCKET_INVENTORY_FAILED');
  requireCondition(Array.isArray(inventory?.data), 'STORAGE_RESTORE_BUCKET_INVENTORY_INVALID');
  const actualBuckets = inventory.data
    .map((bucket) => {
      requireCondition(
        bucket && typeof bucket === 'object' && bucket.id === bucket.name,
        'STORAGE_RESTORE_BUCKET_INVENTORY_INVALID',
      );
      return bucket.id;
    })
    .sort(compareUtf8);
  requireCondition(
    JSON.stringify(actualBuckets) === JSON.stringify(buckets),
    'STORAGE_RESTORE_BUCKET_INVENTORY_MISMATCH',
  );
  const objectsByBucket = Object.create(null);
  for (const bucket of buckets) {
    let response;
    try {
      response = await client.storage.getBucket(bucket);
    } catch {
      fail('STORAGE_RESTORE_BUCKET_PREFLIGHT_FAILED');
    }
    if (response?.error) fail('STORAGE_RESTORE_BUCKET_PREFLIGHT_FAILED');
    const configuration = normalizeTargetBucketConfiguration(bucket, response?.data);
    requireCondition(
      JSON.stringify(configuration) === JSON.stringify(expectedConfigurations[bucket]),
      'STORAGE_RESTORE_BUCKET_CONFIGURATION_MISMATCH',
    );
    objectsByBucket[bucket] = await listTargetObjects(client, bucket);
  }
  return Object.freeze(objectsByBucket);
}

async function hashDownloadedObject(storage, objectKey, expectedByteLength) {
  let response;
  try {
    response = await storage.download(objectKey, {}, { cache: 'no-store' }).asStream();
  } catch {
    fail('STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED');
  }
  if (response?.error) fail('STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED');
  const stream = response?.data;
  requireCondition(
    stream && typeof stream.getReader === 'function',
    'STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED',
  );
  const reader = stream.getReader();
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      requireCondition(
        result && typeof result === 'object',
        'STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED',
      );
      if (result.done === true) break;
      requireCondition(
        result.done === false && result.value instanceof Uint8Array,
        'STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED',
      );
      byteLength += result.value.byteLength;
      requireCondition(
        byteLength <= expectedByteLength,
        'STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED',
      );
      hash.update(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  requireCondition(
    byteLength === expectedByteLength,
    'STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED',
  );
  return hash.digest('hex');
}

async function uploadAndVerifyObjects(client, entries, extractionDirectory) {
  let restoredBytes = 0;
  for (const entry of entries) {
    const file = path.join(extractionDirectory, ...entry.archivePath.split('/'));
    const storage = client.storage.from(entry.bucket);
    let response;
    try {
      response = await storage.upload(entry.objectKey, createReadStream(file), {
        cacheControl: '3600',
        contentType: entry.mimeType ?? 'application/octet-stream',
        duplex: 'half',
        upsert: false,
      });
    } catch {
      fail('STORAGE_RESTORE_UPLOAD_FAILED');
    }
    if (response?.error) fail('STORAGE_RESTORE_UPLOAD_FAILED');
    const sha256 = await hashDownloadedObject(storage, entry.objectKey, entry.downloadedByteLength);
    requireCondition(sha256 === entry.sha256, 'STORAGE_RESTORE_DOWNLOAD_VERIFICATION_FAILED');
    restoredBytes += entry.downloadedByteLength;
    requireCondition(Number.isSafeInteger(restoredBytes), 'STORAGE_RESTORE_TOTAL_BYTES_INVALID');
  }
  return restoredBytes;
}

function expectedKeysByBucket(entries, buckets) {
  const expected = Object.fromEntries(buckets.map((bucket) => [bucket, []]));
  for (const entry of entries) expected[entry.bucket].push(entry.objectKey);
  for (const bucket of buckets) expected[bucket].sort(compareUtf8);
  return expected;
}

async function assertDisposableTarget(args, accessToken, fetchImpl) {
  try {
    assertLoadTestTarget({
      url: `https://${args.targetProjectRef}.supabase.co`,
      disposableRef: args.targetProjectRef,
      confirmation: args.targetConfirmation,
      marker: args.disposableMarker,
    });
    await assertDisposableProjectMarker({
      projectRef: args.targetProjectRef,
      accessToken,
      fetchImpl,
    });
  } catch {
    fail('STORAGE_RESTORE_DISPOSABLE_TARGET_REQUIRED');
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    fetchImpl = globalThis.fetch,
    createClientImpl = createClient,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  const args = parseArguments(argv);
  const backupDirectory = await requirePhysicalBackupDirectory(args.backupDirectory);
  let archivePassphrase = '';
  let serviceKey = '';
  let accessToken = '';
  let temporaryDirectory;
  let summary;
  try {
    archivePassphrase = await readPortableRecoveryKey(args.recoveryKeyFile);
    const verifiedBackup = await readVerifiedStorageByteBackupForRestore({
      backupDirectory,
      expectedProjectRef: args.sourceProjectRef,
      buckets: args.buckets,
      archivePassphrase,
    });
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'safetyhub-storage-restore-'));
    await chmod(temporaryDirectory, 0o700);
    const materialized = await materializeVerifiedStorageBackup({
      verifiedBackup,
      archivePassphrase,
      temporaryDirectory,
    });

    const environment = await readOperatorEnvironmentFile(args.environmentFile, [
      'SUPABASE_SECRET_KEY',
      'SUPABASE_ACCESS_TOKEN',
    ]);
    serviceKey = readServiceCredential({ serviceRoleKeyEnv: 'SUPABASE_SECRET_KEY' }, environment);
    accessToken = environment.SUPABASE_ACCESS_TOKEN;
    requireCondition(
      accessToken.length >= 32 && !/replace|example|placeholder/iu.test(accessToken),
      'STORAGE_RESTORE_ACCESS_TOKEN_INVALID',
    );

    await assertDisposableTarget(args, accessToken, fetchImpl);
    const boundedFetch = createBoundedFetch(args.requestTimeoutMs, fetchImpl);
    const client = createClientImpl(`https://${args.targetProjectRef}.supabase.co`, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch },
    });
    const before = await inspectDisposableStorageTarget(
      client,
      args.buckets,
      verifiedBackup.restoreDetails.bucketConfigurations,
    );
    requireCondition(
      args.buckets.every((bucket) => before[bucket].length === 0),
      'STORAGE_RESTORE_TARGET_NOT_EMPTY',
    );

    // Repeat the production deny and Management API marker immediately before
    // the first remote mutation. Uploads use upsert=false and never delete.
    await assertDisposableTarget(args, accessToken, fetchImpl);
    const restoredBytes = await uploadAndVerifyObjects(
      client,
      verifiedBackup.restoreDetails.entries,
      materialized.extractionDirectory,
    );
    const after = await inspectDisposableStorageTarget(
      client,
      args.buckets,
      verifiedBackup.restoreDetails.bucketConfigurations,
    );
    const expected = expectedKeysByBucket(verifiedBackup.restoreDetails.entries, args.buckets);
    requireCondition(
      args.buckets.every(
        (bucket) => JSON.stringify(after[bucket]) === JSON.stringify(expected[bucket]),
      ),
      'STORAGE_RESTORE_FINAL_INVENTORY_MISMATCH',
    );
    summary = {
      ok: true,
      sourceProjectRef: args.sourceProjectRef,
      targetProjectRef: args.targetProjectRef,
      disposableProjectMarkerVerified: true,
      buckets: args.buckets,
      restoredObjects: verifiedBackup.restoreDetails.entries.length,
      restoredBytes,
      archiveSha256: verifiedBackup.restoreDetails.archiveSha256,
      everyUploadedObjectRedownloadedAndHashed: true,
      targetInventoryMatched: true,
    };
  } finally {
    archivePassphrase = '';
    serviceKey = '';
    accessToken = '';
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  writeOutput(`${JSON.stringify({ ...summary, temporaryPlaintextRemoved: true })}\n`);
  return { ...summary, temporaryPlaintextRemoved: true };
}

function safeErrorCode(error) {
  if (error instanceof OperatorToolError || error instanceof ProductionOperatorError)
    return error.code;
  return 'STORAGE_RESTORE_REHEARSAL_FAILED';
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: 'failed', code: safeErrorCode(error), usage: USAGE })}\n`,
    );
    process.exitCode = 1;
  });
}
