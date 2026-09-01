import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertPhysicalPathRelationship } from './database-backup-security.mjs';
import {
  EncryptedTarWriter,
  OperatorToolError,
  encryptBufferToFile,
  readEncryptedBuffer,
  validatePrivateOutputDirectory,
  verifyEncryptedTar,
} from './storage-operator-tools.mjs';

export const STORAGE_BYTE_BACKUP_KIND = 'safetyhub-linked-storage-byte-backup-v1';
export const STORAGE_BYTE_BACKUP_MANIFEST_KIND = 'safetyhub-linked-storage-byte-backup-manifest-v1';
export const STORAGE_BYTE_BACKUP_TAR_CONTENT_TYPE =
  'application/x-tar; profile=safetyhub-storage-byte-backup-v1';
export const STORAGE_BYTE_BACKUP_MANIFEST_CONTENT_TYPE =
  'application/json; profile=safetyhub-storage-byte-backup-manifest-v1';
export const SAFETYHUB_STORAGE_BUCKET_ALLOWLIST = Object.freeze([
  'content-media',
  'course-presentations',
  'course-presentations-staging',
  'profile-avatars',
]);

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SAFE_MANIFEST_OBJECT_KEY_BYTES = 1_024;
const MAX_VISIBLE_OBJECTS_PER_BUCKET = 1_000_000;
const MAX_VISIBLE_DIRECTORIES_PER_BUCKET = 1_000_000;
const MAX_STORAGE_LIST_REQUESTS_PER_BUCKET = 10_000_000;
const MAX_TAR_ENTRY_BYTES = 8 * 1024 * 1024 * 1024 - 1;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const GENERIC_SERVICE_KEY_CONFIG = Object.freeze({ serviceRoleKeyEnv: 'SUPABASE_SECRET_KEY' });

function fail(code) {
  throw new OperatorToolError(code);
}

function requireCondition(value, code) {
  if (!value) fail(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function safeObjectKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= SAFE_MANIFEST_OBJECT_KEY_BYTES &&
    !value.includes('\0')
  );
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

function normalizeListedMetadata(item, byteSize) {
  return {
    storageMetadataId: typeof item.id === 'string' ? item.id : null,
    createdAt: typeof item.created_at === 'string' ? item.created_at : null,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : null,
    lastAccessedAt: typeof item.last_accessed_at === 'string' ? item.last_accessed_at : null,
    listedByteLength: byteSize,
    etag:
      typeof item.metadata?.eTag === 'string'
        ? item.metadata.eTag
        : typeof item.metadata?.etag === 'string'
          ? item.metadata.etag
          : '',
    mimeType:
      typeof item.metadata?.mimetype === 'string'
        ? item.metadata.mimetype
        : typeof item.metadata?.contentType === 'string'
          ? item.metadata.contentType
          : null,
  };
}

function safeTimestamp(value) {
  return value.replace(/[:.]/gu, '-');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sortedUniqueBuckets(buckets) {
  requireCondition(Array.isArray(buckets) && buckets.length > 0, 'STORAGE_BACKUP_BUCKETS_REQUIRED');
  const allowed = new Set(SAFETYHUB_STORAGE_BUCKET_ALLOWLIST);
  const result = [...buckets];
  requireCondition(
    result.every((bucket) => typeof bucket === 'string' && allowed.has(bucket)),
    'STORAGE_BACKUP_BUCKET_NOT_ALLOWED',
  );
  const sorted = [...result].sort(compareUtf8);
  requireCondition(new Set(sorted).size === sorted.length, 'STORAGE_BACKUP_BUCKET_DUPLICATE');
  requireCondition(
    sorted.length === SAFETYHUB_STORAGE_BUCKET_ALLOWLIST.length &&
      sorted.every((bucket, index) => bucket === SAFETYHUB_STORAGE_BUCKET_ALLOWLIST[index]),
    'STORAGE_BACKUP_BUCKET_SET_INCOMPLETE',
  );
  return Object.freeze(sorted);
}

export function validateStorageBackupRequest({ expectedProjectRef, buckets }) {
  requireCondition(
    typeof expectedProjectRef === 'string' && PROJECT_REF_PATTERN.test(expectedProjectRef),
    'STORAGE_BACKUP_PROJECT_REF_INVALID',
  );
  return Object.freeze({
    expectedProjectRef,
    buckets: sortedUniqueBuckets(buckets),
    supabaseUrl: `https://${expectedProjectRef}.supabase.co`,
  });
}

function normalizeBucketConfiguration(bucket, data) {
  requireCondition(isPlainObject(data), 'STORAGE_BACKUP_BUCKET_CONFIGURATION_MALFORMED');
  requireCondition(
    data.id === bucket && data.name === bucket,
    'STORAGE_BACKUP_BUCKET_CONFIGURATION_MISMATCH',
  );
  requireCondition(
    typeof data.public === 'boolean',
    'STORAGE_BACKUP_BUCKET_CONFIGURATION_MALFORMED',
  );
  requireCondition(
    data.file_size_limit === null ||
      (Number.isSafeInteger(data.file_size_limit) && data.file_size_limit >= 0),
    'STORAGE_BACKUP_BUCKET_CONFIGURATION_MALFORMED',
  );
  requireCondition(
    data.allowed_mime_types === null ||
      (Array.isArray(data.allowed_mime_types) &&
        data.allowed_mime_types.every((value) => typeof value === 'string')),
    'STORAGE_BACKUP_BUCKET_CONFIGURATION_MALFORMED',
  );
  return Object.freeze({
    id: bucket,
    public: data.public,
    fileSizeLimitBytes: data.file_size_limit,
    allowedMimeTypes: data.allowed_mime_types === null ? null : [...data.allowed_mime_types],
  });
}

async function readBucketConfiguration(client, bucket) {
  requireCondition(
    typeof client?.storage?.getBucket === 'function',
    'STORAGE_BACKUP_BUCKET_PREFLIGHT_UNSUPPORTED',
  );
  let response;
  try {
    response = await client.storage.getBucket(bucket);
  } catch {
    fail('STORAGE_BACKUP_BUCKET_PREFLIGHT_FAILED');
  }
  if (response?.error) fail('STORAGE_BACKUP_BUCKET_PREFLIGHT_FAILED');
  return normalizeBucketConfiguration(bucket, response?.data);
}

async function requireExactVisibleBucketInventory(client, expectedBuckets) {
  requireCondition(
    typeof client?.storage?.listBuckets === 'function',
    'STORAGE_BACKUP_BUCKET_INVENTORY_UNSUPPORTED',
  );
  let response;
  try {
    response = await client.storage.listBuckets();
  } catch {
    fail('STORAGE_BACKUP_BUCKET_INVENTORY_FAILED');
  }
  if (response?.error) fail('STORAGE_BACKUP_BUCKET_INVENTORY_FAILED');
  requireCondition(Array.isArray(response?.data), 'STORAGE_BACKUP_BUCKET_INVENTORY_MALFORMED');
  const names = response.data.map((bucket) => {
    requireCondition(isPlainObject(bucket), 'STORAGE_BACKUP_BUCKET_INVENTORY_MALFORMED');
    requireCondition(
      typeof bucket.id === 'string' && bucket.id === bucket.name,
      'STORAGE_BACKUP_BUCKET_INVENTORY_MALFORMED',
    );
    return bucket.id;
  });
  const sortedNames = [...names].sort(compareUtf8);
  requireCondition(
    new Set(sortedNames).size === sortedNames.length,
    'STORAGE_BACKUP_BUCKET_INVENTORY_MALFORMED',
  );
  requireCondition(
    sortedNames.length === expectedBuckets.length &&
      sortedNames.every((bucket, index) => bucket === expectedBuckets[index]),
    'STORAGE_BACKUP_BUCKET_INVENTORY_MISMATCH',
  );
}

function isStorageFolder(item) {
  if (item.id === null) {
    requireCondition(item.metadata === null, 'STORAGE_BACKUP_FOLDER_ENTRY_MALFORMED');
    return true;
  }
  requireCondition(
    typeof item.id === 'string' && item.id.length > 0,
    'STORAGE_BACKUP_FILE_ENTRY_MALFORMED',
  );
  requireCondition(isPlainObject(item.metadata), 'STORAGE_BACKUP_FILE_ENTRY_MALFORMED');
  return false;
}

async function listBucketObjects(client, bucket, pageSize) {
  requireCondition(
    Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 1_000,
    'STORAGE_BACKUP_PAGE_SIZE_INVALID',
  );
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
    requireCondition(
      directoryCount <= MAX_VISIBLE_DIRECTORIES_PER_BUCKET,
      'STORAGE_BACKUP_DIRECTORY_LIMIT',
    );

    for (; pages < MAX_STORAGE_LIST_REQUESTS_PER_BUCKET; pages += 1) {
      listRequests += 1;
      requireCondition(
        listRequests <= MAX_STORAGE_LIST_REQUESTS_PER_BUCKET,
        'STORAGE_BACKUP_LIST_REQUEST_LIMIT',
      );
      let response;
      try {
        response = await storage.list(prefix, {
          limit: pageSize,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        });
      } catch {
        fail('STORAGE_BACKUP_LIST_FAILED');
      }
      if (response?.error) fail('STORAGE_BACKUP_LIST_FAILED');
      requireCondition(Array.isArray(response?.data), 'STORAGE_BACKUP_LIST_RESPONSE_MALFORMED');

      for (const item of response.data) {
        requireCondition(isPlainObject(item), 'STORAGE_BACKUP_LIST_ENTRY_MALFORMED');
        requireCondition(safePathComponent(item.name), 'STORAGE_BACKUP_LIST_NAME_MALFORMED');
        const objectKey = prefix === '' ? item.name : `${prefix}/${item.name}`;
        requireCondition(safeObjectKey(objectKey), 'STORAGE_BACKUP_OBJECT_KEY_MALFORMED');
        if (isStorageFolder(item)) {
          requireCondition(!seenDirectories.has(objectKey), 'STORAGE_BACKUP_DIRECTORY_DUPLICATE');
          seenDirectories.add(objectKey);
          directories.push(objectKey);
          continue;
        }

        requireCondition(!seenObjects.has(objectKey), 'STORAGE_BACKUP_OBJECT_DUPLICATE');
        const byteSize = visibleByteSize(item);
        requireCondition(byteSize !== null, 'STORAGE_BACKUP_OBJECT_SIZE_MALFORMED');
        requireCondition(byteSize <= MAX_TAR_ENTRY_BYTES, 'STORAGE_BACKUP_OBJECT_TOO_LARGE');
        seenObjects.add(objectKey);
        objects.push({
          bucket,
          objectKey,
          ...normalizeListedMetadata(item, byteSize),
        });
        requireCondition(
          objects.length <= MAX_VISIBLE_OBJECTS_PER_BUCKET,
          'STORAGE_BACKUP_OBJECT_LIMIT',
        );
      }

      if (response.data.length < pageSize) break;
      offset += pageSize;
    }
    requireCondition(
      pages < MAX_STORAGE_LIST_REQUESTS_PER_BUCKET,
      'STORAGE_BACKUP_PAGINATION_LIMIT',
    );
  }

  objects.sort((left, right) => compareUtf8(left.objectKey, right.objectKey));
  return { storage, directoryCount, listRequests, objects };
}

async function downloadAsWebStream(storage, objectKey) {
  let request;
  try {
    request = storage.download(objectKey, {}, { cache: 'no-store' });
  } catch {
    fail('STORAGE_BACKUP_DOWNLOAD_FAILED');
  }
  requireCondition(
    request !== null && typeof request === 'object' && typeof request.asStream === 'function',
    'STORAGE_BACKUP_DOWNLOAD_STREAM_UNSUPPORTED',
  );
  let response;
  try {
    response = await request.asStream();
  } catch {
    fail('STORAGE_BACKUP_DOWNLOAD_FAILED');
  }
  if (response?.error) fail('STORAGE_BACKUP_DOWNLOAD_FAILED');
  requireCondition(
    response?.data !== null && typeof response?.data === 'object',
    'STORAGE_BACKUP_DOWNLOAD_STREAM_MALFORMED',
  );
  return response.data;
}

function objectSetSha256(entries) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((entry) => [entry.bucket, entry.objectKey, entry.listedByteLength, entry.etag]),
      ),
    )
    .digest('hex');
}

function downloadSetSha256(entries) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((entry) => [
          entry.bucket,
          entry.objectKey,
          entry.downloadedByteLength,
          entry.sha256,
        ]),
      ),
    )
    .digest('hex');
}

function bucketTotals(entries, buckets) {
  const totals = Object.fromEntries(buckets.map((bucket) => [bucket, { objects: 0, bytes: 0 }]));
  for (const entry of entries) {
    const total = totals[entry.bucket];
    requireCondition(total !== undefined, 'STORAGE_BACKUP_MANIFEST_BUCKET_UNEXPECTED');
    total.objects += 1;
    total.bytes += entry.downloadedByteLength;
    requireCondition(Number.isSafeInteger(total.bytes), 'STORAGE_BACKUP_TOTAL_BYTES_OVERFLOW');
  }
  return totals;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch {
    fail('STORAGE_BACKUP_ARCHIVE_HASH_FAILED');
  }
  return hash.digest('hex');
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
    fail('STORAGE_BACKUP_RECEIPT_WRITE_FAILED');
  }
}

export async function runStorageByteBackup({
  client,
  expectedProjectRef,
  buckets,
  archivePassphrase,
  outputDirectory,
  repositoryRoot,
  pageSize = 100,
  now = () => new Date(),
}) {
  requireCondition(client !== null && typeof client === 'object', 'STORAGE_BACKUP_CLIENT_REQUIRED');
  requireCondition(
    typeof archivePassphrase === 'string' && Buffer.byteLength(archivePassphrase, 'utf8') >= 32,
    'STORAGE_BACKUP_PASSPHRASE_TOO_SHORT',
  );
  const request = validateStorageBackupRequest({ expectedProjectRef, buckets });
  const resolvedOutputDirectory = await validatePrivateOutputDirectory(
    outputDirectory,
    repositoryRoot,
  );
  requireCondition(
    Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 1_000,
    'STORAGE_BACKUP_PAGE_SIZE_INVALID',
  );
  const capturedAtDate = now();
  requireCondition(
    capturedAtDate instanceof Date && Number.isFinite(capturedAtDate.getTime()),
    'STORAGE_BACKUP_CLOCK_INVALID',
  );

  await requireExactVisibleBucketInventory(client, request.buckets);
  const bucketStates = [];
  for (const bucket of request.buckets) {
    const configuration = await readBucketConfiguration(client, bucket);
    const listed = await listBucketObjects(client, bucket, pageSize);
    bucketStates.push({ bucket, configuration, ...listed });
  }

  const runId = randomBytes(12).toString('hex');
  const runDirectoryName = `safetyhub-storage-byte-backup-${safeTimestamp(capturedAtDate.toISOString())}-${runId}`;
  const runDirectory = path.join(resolvedOutputDirectory, runDirectoryName);
  const archiveTemporary = path.join(runDirectory, 'storage.tar.aes256gcm.incomplete');
  const archiveFile = path.join(runDirectory, 'storage.tar.aes256gcm');
  const manifestTemporary = path.join(runDirectory, 'manifest.json.aes256gcm.incomplete');
  const manifestFile = path.join(runDirectory, 'manifest.json.aes256gcm');
  const receiptFile = path.join(runDirectory, 'receipt.json');
  let archiveWriter;
  let manifestBytes;
  let runDirectoryCreated = false;

  try {
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });
    runDirectoryCreated = true;
    await chmod(runDirectory, 0o700);
    archiveWriter = await EncryptedTarWriter.create(
      archiveTemporary,
      archivePassphrase,
      Math.floor(capturedAtDate.getTime() / 1_000),
      STORAGE_BYTE_BACKUP_TAR_CONTENT_TYPE,
    );

    const entries = [];
    const expectedArchiveEntries = [];
    let objectIndex = 0;
    for (const state of bucketStates) {
      for (const object of state.objects) {
        objectIndex += 1;
        const archivePath = `objects/${String(objectIndex).padStart(8, '0')}.bin`;
        const stream = await downloadAsWebStream(state.storage, object.objectKey);
        const downloaded = await archiveWriter.addWebStream(
          archivePath,
          object.listedByteLength,
          stream,
        );
        expectedArchiveEntries.push({
          name: archivePath,
          size: downloaded.byteLength,
          sha256: downloaded.sha256,
        });
        entries.push({
          bucket: object.bucket,
          objectKey: object.objectKey,
          archivePath,
          storageMetadataId: object.storageMetadataId,
          createdAt: object.createdAt,
          updatedAt: object.updatedAt,
          lastAccessedAt: object.lastAccessedAt,
          listedByteLength: object.listedByteLength,
          downloadedByteLength: downloaded.byteLength,
          etag: object.etag,
          mimeType: object.mimeType,
          sha256: downloaded.sha256,
        });
      }
    }

    const totals = bucketTotals(entries, request.buckets);
    const archivedBytes = entries.reduce((sum, entry) => sum + entry.downloadedByteLength, 0);
    requireCondition(Number.isSafeInteger(archivedBytes), 'STORAGE_BACKUP_TOTAL_BYTES_OVERFLOW');
    const manifest = {
      manifestVersion: 1,
      kind: STORAGE_BYTE_BACKUP_MANIFEST_KIND,
      capturedAt: capturedAtDate.toISOString(),
      projectRef: request.expectedProjectRef,
      buckets: request.buckets,
      bucketConfigurations: Object.fromEntries(
        bucketStates.map((state) => [state.bucket, state.configuration]),
      ),
      coverage: {
        recursivelyPaginatedVisibleBucketMetadata: true,
        downloadedEveryListedVisibleObject: true,
        verifiedListedByteLengthAndSha256: true,
        exactVisibleBucketInventoryVerified: true,
        bucketPreflightReadOnly: true,
        sourceConsistencyOrWriteDrainVerifiedByTool: false,
        physicalBackendOrVersionInventoryPerformed: false,
      },
      counts: {
        archivedObjects: entries.length,
        archivedBytes,
        buckets: totals,
      },
      objectSetSha256: objectSetSha256(entries),
      downloadSetSha256: downloadSetSha256(entries),
      entries,
      limitations: [
        'This backup covers objects visible through the documented Storage listing API at capture time.',
        'Listing and byte downloads are not an atomic cross-bucket snapshot; use an external write drain for a stable recovery point.',
        'It does not inspect hidden backend versions, sidecars, retry queues, or deleted physical objects.',
      ],
    };
    manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    requireCondition(
      manifestBytes.byteLength <= MAX_MANIFEST_BYTES,
      'STORAGE_BACKUP_MANIFEST_TOO_LARGE',
    );
    await archiveWriter.addFile('manifest.json', manifestBytes);
    expectedArchiveEntries.push({
      name: 'manifest.json',
      size: manifestBytes.length,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    });
    await archiveWriter.finish();
    archiveWriter = null;

    await encryptBufferToFile(
      manifestTemporary,
      archivePassphrase,
      STORAGE_BYTE_BACKUP_MANIFEST_CONTENT_TYPE,
      manifestBytes,
    );
    await verifyEncryptedTar(
      archiveTemporary,
      archivePassphrase,
      expectedArchiveEntries,
      STORAGE_BYTE_BACKUP_TAR_CONTENT_TYPE,
    );
    const verifiedManifest = await readEncryptedBuffer(
      manifestTemporary,
      archivePassphrase,
      STORAGE_BYTE_BACKUP_MANIFEST_CONTENT_TYPE,
      MAX_MANIFEST_BYTES,
    );
    try {
      requireCondition(
        verifiedManifest.equals(manifestBytes),
        'STORAGE_BACKUP_MANIFEST_VERIFICATION_FAILED',
      );
    } finally {
      verifiedManifest.fill(0);
    }

    const archiveSha256 = await sha256File(archiveTemporary);
    await rename(archiveTemporary, archiveFile);
    await rename(manifestTemporary, manifestFile);
    const receipt = {
      receiptVersion: 1,
      kind: STORAGE_BYTE_BACKUP_KIND,
      status: 'complete',
      capturedAt: capturedAtDate.toISOString(),
      projectRef: request.expectedProjectRef,
      buckets: request.buckets,
      runDirectoryName,
      files: {
        encryptedArchive: path.basename(archiveFile),
        encryptedManifest: path.basename(manifestFile),
      },
      archivedObjects: entries.length,
      archivedBytes,
      bucketTotals: totals,
      objectSetSha256: objectSetSha256(entries),
      downloadSetSha256: downloadSetSha256(entries),
      archiveSha256,
      archiveVerified: true,
      manifestVerified: true,
      sourceConsistencyOrWriteDrainVerifiedByTool: false,
      physicalBackendOrVersionInventoryPerformed: false,
      backendPhysicalOrVersionVerdict: 'not-assessed',
    };
    await writePrivateJson(receiptFile, receipt);
    return { ...receipt, runDirectory };
  } catch (error) {
    await archiveWriter?.abort().catch(() => {});
    if (runDirectoryCreated)
      await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof OperatorToolError) throw error;
    fail('STORAGE_BACKUP_FAILED');
  } finally {
    manifestBytes?.fill(0);
  }
}

function exactBucketSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((bucket, index) => bucket === expected[index])
  );
}

async function resolveBackupInputFile(backupDirectory, name, maximumBytes) {
  const candidate = path.join(backupDirectory, name);
  let stats;
  let physical;
  try {
    stats = await lstat(candidate);
    requireCondition(
      stats.isFile() && !stats.isSymbolicLink(),
      'STORAGE_BACKUP_INPUT_FILE_INVALID',
    );
    requireCondition(stats.size > 0, 'STORAGE_BACKUP_INPUT_FILE_INVALID');
    if (maximumBytes !== undefined) {
      requireCondition(stats.size <= maximumBytes, 'STORAGE_BACKUP_INPUT_FILE_INVALID');
    }
    physical = await realpath(candidate);
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    fail('STORAGE_BACKUP_INPUT_FILE_INVALID');
  }
  requireCondition(
    path.relative(backupDirectory, physical) === name,
    'STORAGE_BACKUP_INPUT_FILE_INVALID',
  );
  return physical;
}

function validateBucketTotals(value, buckets, entries) {
  requireCondition(isPlainObject(value), 'STORAGE_BACKUP_RECEIPT_INVALID');
  const calculated = bucketTotals(entries, buckets);
  requireCondition(
    JSON.stringify(value) === JSON.stringify(calculated),
    'STORAGE_BACKUP_RECEIPT_INVALID',
  );
  return calculated;
}

function validateManifestBucketConfigurations(value, buckets) {
  requireCondition(isPlainObject(value), 'STORAGE_BACKUP_MANIFEST_INVALID');
  requireCondition(
    Object.keys(value)
      .sort(compareUtf8)
      .every((bucket, index) => bucket === buckets[index]) &&
      Object.keys(value).length === buckets.length,
    'STORAGE_BACKUP_MANIFEST_INVALID',
  );
  return Object.freeze(
    Object.fromEntries(
      buckets.map((bucket) => {
        const configuration = value[bucket];
        requireCondition(isPlainObject(configuration), 'STORAGE_BACKUP_MANIFEST_INVALID');
        requireCondition(
          Object.keys(configuration).sort(compareUtf8).join('\0') ===
            ['allowedMimeTypes', 'fileSizeLimitBytes', 'id', 'public']
              .sort(compareUtf8)
              .join('\0') &&
            configuration.id === bucket &&
            typeof configuration.public === 'boolean' &&
            (configuration.fileSizeLimitBytes === null ||
              (Number.isSafeInteger(configuration.fileSizeLimitBytes) &&
                configuration.fileSizeLimitBytes >= 0)) &&
            (configuration.allowedMimeTypes === null ||
              (Array.isArray(configuration.allowedMimeTypes) &&
                new Set(configuration.allowedMimeTypes).size ===
                  configuration.allowedMimeTypes.length &&
                configuration.allowedMimeTypes.every(
                  (mimeType) =>
                    typeof mimeType === 'string' &&
                    mimeType.length > 0 &&
                    mimeType.length <= 255 &&
                    !/[\u0000-\u001f\u007f]/u.test(mimeType),
                ))),
          'STORAGE_BACKUP_MANIFEST_INVALID',
        );
        return [
          bucket,
          Object.freeze({
            id: bucket,
            public: configuration.public,
            fileSizeLimitBytes: configuration.fileSizeLimitBytes,
            allowedMimeTypes:
              configuration.allowedMimeTypes === null
                ? null
                : Object.freeze([...configuration.allowedMimeTypes]),
          }),
        ];
      }),
    ),
  );
}

function validateManifest(manifest, request) {
  requireCondition(isPlainObject(manifest), 'STORAGE_BACKUP_MANIFEST_INVALID');
  requireCondition(
    manifest.manifestVersion === 1 &&
      manifest.kind === STORAGE_BYTE_BACKUP_MANIFEST_KIND &&
      manifest.projectRef === request.expectedProjectRef &&
      exactBucketSet(manifest.buckets, request.buckets) &&
      manifest.coverage?.downloadedEveryListedVisibleObject === true &&
      manifest.coverage?.verifiedListedByteLengthAndSha256 === true &&
      manifest.coverage?.exactVisibleBucketInventoryVerified === true &&
      Array.isArray(manifest.entries),
    'STORAGE_BACKUP_MANIFEST_INVALID',
  );
  const bucketConfigurations = validateManifestBucketConfigurations(
    manifest.bucketConfigurations,
    request.buckets,
  );
  requireCondition(
    manifest.entries.length <= MAX_VISIBLE_OBJECTS_PER_BUCKET * request.buckets.length,
    'STORAGE_BACKUP_MANIFEST_INVALID',
  );
  const seenArchivePaths = new Set();
  const seenObjects = new Set();
  const entries = manifest.entries.map((entry, index) => {
    requireCondition(isPlainObject(entry), 'STORAGE_BACKUP_MANIFEST_INVALID');
    requireCondition(request.buckets.includes(entry.bucket), 'STORAGE_BACKUP_MANIFEST_INVALID');
    requireCondition(safeObjectKey(entry.objectKey), 'STORAGE_BACKUP_MANIFEST_INVALID');
    const archivePath = `objects/${String(index + 1).padStart(8, '0')}.bin`;
    requireCondition(entry.archivePath === archivePath, 'STORAGE_BACKUP_MANIFEST_INVALID');
    requireCondition(!seenArchivePaths.has(entry.archivePath), 'STORAGE_BACKUP_MANIFEST_INVALID');
    const objectId = `${entry.bucket}\0${entry.objectKey}`;
    requireCondition(!seenObjects.has(objectId), 'STORAGE_BACKUP_MANIFEST_INVALID');
    seenArchivePaths.add(entry.archivePath);
    seenObjects.add(objectId);
    requireCondition(
      Number.isSafeInteger(entry.listedByteLength) &&
        entry.listedByteLength >= 0 &&
        entry.listedByteLength <= MAX_TAR_ENTRY_BYTES &&
        entry.downloadedByteLength === entry.listedByteLength &&
        typeof entry.etag === 'string' &&
        (entry.mimeType === null ||
          (typeof entry.mimeType === 'string' &&
            entry.mimeType.length > 0 &&
            entry.mimeType.length <= 255 &&
            !/[\u0000-\u001f\u007f]/u.test(entry.mimeType))) &&
        /^[0-9a-f]{64}$/u.test(entry.sha256 ?? ''),
      'STORAGE_BACKUP_MANIFEST_INVALID',
    );
    return entry;
  });
  const archivedBytes = entries.reduce((sum, entry) => sum + entry.downloadedByteLength, 0);
  requireCondition(Number.isSafeInteger(archivedBytes), 'STORAGE_BACKUP_MANIFEST_INVALID');
  requireCondition(
    manifest.counts?.archivedObjects === entries.length &&
      manifest.counts?.archivedBytes === archivedBytes &&
      /^[0-9a-f]{64}$/u.test(manifest.objectSetSha256 ?? '') &&
      manifest.objectSetSha256 === objectSetSha256(entries) &&
      /^[0-9a-f]{64}$/u.test(manifest.downloadSetSha256 ?? '') &&
      manifest.downloadSetSha256 === downloadSetSha256(entries),
    'STORAGE_BACKUP_MANIFEST_INVALID',
  );
  validateBucketTotals(manifest.counts?.buckets, request.buckets, entries);
  return { bucketConfigurations, entries, archivedBytes };
}

async function verifyStorageByteBackupInternal(
  { backupDirectory, expectedProjectRef, buckets, archivePassphrase },
  includeRestoreDetails,
) {
  requireCondition(
    typeof backupDirectory === 'string' && path.isAbsolute(backupDirectory),
    'STORAGE_BACKUP_VERIFY_PATH_INVALID',
  );
  requireCondition(
    typeof archivePassphrase === 'string' && Buffer.byteLength(archivePassphrase, 'utf8') >= 32,
    'STORAGE_BACKUP_PASSPHRASE_TOO_SHORT',
  );
  const request = validateStorageBackupRequest({ expectedProjectRef, buckets });
  const requestedBackup = path.resolve(backupDirectory);
  let resolvedBackup;
  try {
    const stats = await lstat(requestedBackup);
    requireCondition(
      stats.isDirectory() && !stats.isSymbolicLink(),
      'STORAGE_BACKUP_VERIFY_PATH_INVALID',
    );
    resolvedBackup = await realpath(requestedBackup);
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    fail('STORAGE_BACKUP_VERIFY_PATH_INVALID');
  }
  const receiptFile = await resolveBackupInputFile(
    resolvedBackup,
    'receipt.json',
    MAX_RECEIPT_BYTES,
  );
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  } catch {
    fail('STORAGE_BACKUP_RECEIPT_INVALID');
  }
  requireCondition(
    isPlainObject(receipt) &&
      receipt.receiptVersion === 1 &&
      receipt.kind === STORAGE_BYTE_BACKUP_KIND &&
      receipt.status === 'complete' &&
      receipt.projectRef === request.expectedProjectRef &&
      exactBucketSet(receipt.buckets, request.buckets) &&
      receipt.archiveVerified === true &&
      receipt.manifestVerified === true &&
      receipt.files?.encryptedArchive === 'storage.tar.aes256gcm' &&
      receipt.files?.encryptedManifest === 'manifest.json.aes256gcm' &&
      /^[0-9a-f]{64}$/u.test(receipt.archiveSha256 ?? '') &&
      /^[0-9a-f]{64}$/u.test(receipt.objectSetSha256 ?? '') &&
      /^[0-9a-f]{64}$/u.test(receipt.downloadSetSha256 ?? ''),
    'STORAGE_BACKUP_RECEIPT_INVALID',
  );

  const archiveFile = await resolveBackupInputFile(resolvedBackup, receipt.files.encryptedArchive);
  const manifestFile = await resolveBackupInputFile(
    resolvedBackup,
    receipt.files.encryptedManifest,
    MAX_MANIFEST_BYTES + 8_192,
  );

  const manifestBytes = await readEncryptedBuffer(
    manifestFile,
    archivePassphrase,
    STORAGE_BYTE_BACKUP_MANIFEST_CONTENT_TYPE,
    MAX_MANIFEST_BYTES,
  );
  try {
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      fail('STORAGE_BACKUP_MANIFEST_INVALID');
    }
    const { bucketConfigurations, entries, archivedBytes } = validateManifest(manifest, request);
    requireCondition(
      receipt.archivedObjects === entries.length &&
        receipt.archivedBytes === archivedBytes &&
        receipt.objectSetSha256 === objectSetSha256(entries) &&
        receipt.downloadSetSha256 === downloadSetSha256(entries),
      'STORAGE_BACKUP_RECEIPT_INVALID',
    );
    validateBucketTotals(receipt.bucketTotals, request.buckets, entries);
    const expectedEntries = entries.map((entry) => ({
      name: entry.archivePath,
      size: entry.downloadedByteLength,
      sha256: entry.sha256,
    }));
    expectedEntries.push({
      name: 'manifest.json',
      size: manifestBytes.length,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    });
    await verifyEncryptedTar(
      archiveFile,
      archivePassphrase,
      expectedEntries,
      STORAGE_BYTE_BACKUP_TAR_CONTENT_TYPE,
    );
    requireCondition(
      (await sha256File(archiveFile)) === receipt.archiveSha256,
      'STORAGE_BACKUP_ARCHIVE_HASH_MISMATCH',
    );
    const summary = {
      ok: true,
      projectRef: request.expectedProjectRef,
      buckets: request.buckets,
      archivedObjects: entries.length,
      archivedBytes,
      archiveAuthenticated: true,
      manifestAuthenticated: true,
      entryHashesVerified: true,
    };
    return includeRestoreDetails
      ? {
          ...summary,
          restoreDetails: Object.freeze({
            archiveFile,
            archiveSha256: receipt.archiveSha256,
            bucketConfigurations,
            entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
            embeddedManifest: Object.freeze({
              name: 'manifest.json',
              size: manifestBytes.length,
              sha256: createHash('sha256').update(manifestBytes).digest('hex'),
            }),
          }),
        }
      : summary;
  } finally {
    manifestBytes.fill(0);
  }
}

export async function verifyStorageByteBackup(options) {
  return verifyStorageByteBackupInternal(options, false);
}

export async function readVerifiedStorageByteBackupForRestore(options) {
  return verifyStorageByteBackupInternal(options, true);
}

export async function assertRecoveryKeyOutsideOutput(
  recoveryKeyOutput,
  outputDirectory,
  {
    candidateExpectation = 'absent',
    expectedOutputPhysicalPath,
    expectedRecoveryKeyPhysicalPath,
  } = {},
) {
  requireCondition(
    typeof recoveryKeyOutput === 'string' && path.isAbsolute(recoveryKeyOutput),
    'STORAGE_BACKUP_RECOVERY_KEY_PATH_INVALID',
  );
  requireCondition(
    typeof outputDirectory === 'string' && path.isAbsolute(outputDirectory),
    'STORAGE_BACKUP_OUTPUT_PATH_INVALID',
  );
  const resolvedRecoveryKey = path.resolve(recoveryKeyOutput);
  const resolvedOutput = path.resolve(outputDirectory);
  try {
    const boundary = await assertPhysicalPathRelationship({
      directoryPath: resolvedOutput,
      candidatePath: resolvedRecoveryKey,
      relationship: 'outside',
      directoryExpectation: 'directory',
      candidateExpectation,
      directoryLabel: 'Storage backup output directory',
      candidateLabel: 'Storage portable recovery key',
      expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
      expectedCandidatePhysicalPath: expectedRecoveryKeyPhysicalPath,
      relationshipError: 'The Storage portable recovery key must stay outside the backup output.',
    });
    return {
      recoveryKeyOutput: boundary.candidate.absolutePath,
      outputPhysicalPath: boundary.directory.physicalPath,
      recoveryKeyPhysicalPath: boundary.candidate.physicalPath,
    };
  } catch {
    fail('STORAGE_BACKUP_RECOVERY_KEY_INSIDE_OUTPUT');
  }
}

export function storageServiceKeyConfig() {
  return GENERIC_SERVICE_KEY_CONFIG;
}
