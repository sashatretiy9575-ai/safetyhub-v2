import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  AVATAR_BUCKET,
  PRODUCTION_PROJECT_REF,
  readEncryptedBuffer,
  verifyEncryptedTar,
} from './storage-operator-tools.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const backupDirectory = args.get('--backup');
const expectedProjectRef = args.get('--expected-project-ref');
const recoveryKeyFile = args.get('--recovery-key-file');
if (!backupDirectory || !expectedProjectRef) {
  console.error(
    'Usage: --backup <encrypted-directory> --expected-project-ref <ref> [--recovery-key-file <file>]',
  );
  process.exit(1);
}
if (!recoveryKeyFile && process.platform !== 'win32') {
  console.error('This backup verifier currently requires Windows DPAPI.');
  process.exit(1);
}
if (expectedProjectRef !== PRODUCTION_PROJECT_REF || !/^[a-z]{20}$/u.test(expectedProjectRef)) {
  throw new Error('Unexpected production project reference.');
}

const resolvedBackup = path.resolve(backupDirectory);
const receipt = JSON.parse(await readFile(path.join(resolvedBackup, 'receipt.json'), 'utf8'));
if (
  receipt?.receiptVersion !== 1 ||
  receipt?.status !== 'complete' ||
  receipt?.projectRef !== expectedProjectRef ||
  receipt?.bucket !== AVATAR_BUCKET ||
  receipt?.archiveVerified !== true ||
  receipt?.manifestVerified !== true ||
  !Number.isSafeInteger(receipt?.archivedObjects) ||
  !Number.isSafeInteger(receipt?.archivedBytes) ||
  !/^[0-9a-f]{64}$/u.test(receipt?.archiveSha256 ?? '')
) {
  throw new Error('Avatar backup receipt is invalid.');
}

let passphrase;
let keyProtection;
if (recoveryKeyFile) {
  const serializedRecoveryKey = (await readFile(path.resolve(recoveryKeyFile), 'utf8')).trim();
  const prefix = 'SAFETYHUB-AVATAR-RECOVERY-KEY-V1:';
  if (!serializedRecoveryKey.startsWith(prefix)) {
    throw new Error('Portable avatar recovery key format is invalid.');
  }
  passphrase = serializedRecoveryKey.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]{64}$/u.test(passphrase)) {
    throw new Error('Portable avatar recovery key is invalid.');
  }
  keyProtection = 'portable-recovery-key';
} else {
  const protectedPassphrase = await readFile(
    path.join(resolvedBackup, 'archive-passphrase.key.dpapi'),
    'utf8',
  );
  const cleanPowerShellEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  const recovered = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Import-Module Microsoft.PowerShell.Security; $secure = ConvertTo-SecureString $env:SAFETYHUB_PROTECTED_AVATAR_KEY; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...cleanPowerShellEnvironment,
        SAFETYHUB_PROTECTED_AVATAR_KEY: protectedPassphrase.trim(),
      },
    },
  );
  if (recovered.status !== 0 || !recovered.stdout.trim()) {
    throw new Error('Windows DPAPI passphrase recovery failed.');
  }
  passphrase = recovered.stdout.trim();
  keyProtection = 'windows-dpapi-current-user';
}
let manifestBytes;
try {
  manifestBytes = await readEncryptedBuffer(
    path.join(resolvedBackup, receipt.files.encryptedManifest),
    passphrase,
    'application/json; profile=safetyhub-avatar-backup-manifest-v1',
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest?.manifestVersion !== 1 ||
    manifest?.kind !== 'safetyhub-private-avatar-byte-backup' ||
    manifest?.projectRef !== expectedProjectRef ||
    manifest?.bucket !== AVATAR_BUCKET ||
    !Array.isArray(manifest?.entries) ||
    manifest.entries.length !== receipt.archivedObjects ||
    manifest?.counts?.archivedObjects !== receipt.archivedObjects ||
    manifest?.counts?.archivedBytes !== receipt.archivedBytes
  ) {
    throw new Error('Avatar backup manifest is invalid.');
  }

  const expectedEntries = manifest.entries.map((entry) => {
    if (
      typeof entry?.archivePath !== 'string' ||
      !/^objects\/[0-9]{8}[.]webp$/u.test(entry.archivePath) ||
      !Number.isSafeInteger(entry?.downloadedByteLength) ||
      entry.downloadedByteLength < 1 ||
      !/^[0-9a-f]{64}$/u.test(entry?.sha256 ?? '')
    ) {
      throw new Error('Avatar backup entry is invalid.');
    }
    return {
      name: entry.archivePath,
      size: entry.downloadedByteLength,
      sha256: entry.sha256,
    };
  });
  expectedEntries.push({
    name: 'manifest.json',
    size: manifestBytes.length,
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
  });

  await verifyEncryptedTar(
    path.join(resolvedBackup, receipt.files.encryptedArchive),
    passphrase,
    expectedEntries,
  );

  const archiveHash = createHash('sha256');
  for await (const chunk of createReadStream(
    path.join(resolvedBackup, receipt.files.encryptedArchive),
  )) {
    archiveHash.update(chunk);
  }
  if (archiveHash.digest('hex') !== receipt.archiveSha256) {
    throw new Error('Encrypted avatar archive checksum mismatch.');
  }

  console.log(
    JSON.stringify({
      ok: true,
      projectRef: expectedProjectRef,
      archivedObjects: receipt.archivedObjects,
      archivedBytes: receipt.archivedBytes,
      manifestAuthenticated: true,
      archiveAuthenticated: true,
      entryHashesVerified: true,
      keyProtection,
    }),
  );
} finally {
  manifestBytes?.fill(0);
  passphrase = '';
}
