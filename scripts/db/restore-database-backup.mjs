import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  assertPhysicalPathRelationship,
  readDatabaseBackupReceipt,
} from './database-backup-security.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const backupDirectory = args.get('--backup');
const outputDirectory = args.get('--output');
const recoveryKeyFile = args.get('--recovery-key-file');
if (!backupDirectory || !outputDirectory) {
  console.error(
    'Usage: --backup <encrypted-directory> --output <new-empty-directory> [--recovery-key-file <file>]',
  );
  process.exit(1);
}

const backup = path.resolve(backupDirectory);
const output = path.resolve(outputDirectory);
const receiptLocation = await assertPhysicalPathRelationship({
  directoryPath: backup,
  candidatePath: path.join(backup, 'receipt.json'),
  relationship: 'inside',
  directoryExpectation: 'directory',
  candidateExpectation: 'file',
  directoryLabel: 'Encrypted backup directory',
  candidateLabel: 'Database backup receipt',
  relationshipError: 'The database backup receipt must stay inside the encrypted backup directory.',
});
const expectedBackupPhysicalPath = receiptLocation.directory.physicalPath;
const receipt = await readDatabaseBackupReceipt(receiptLocation.candidate.absolutePath);
const initialOutputBoundary = await assertPhysicalPathRelationship({
  directoryPath: backup,
  candidatePath: output,
  relationship: 'outside',
  directoryExpectation: 'directory',
  candidateExpectation: 'absent',
  directoryLabel: 'Encrypted backup directory',
  candidateLabel: 'Plaintext restore directory',
  expectedDirectoryPhysicalPath: expectedBackupPhysicalPath,
  relationshipError: 'The plaintext restore directory must be outside the encrypted backup directory.',
});
const expectedOutputPhysicalPath = initialOutputBoundary.candidate.physicalPath;

async function existingBackupFile(name, label, expectedPhysicalPath) {
  const result = await assertPhysicalPathRelationship({
    directoryPath: backup,
    candidatePath: path.join(backup, name),
    relationship: 'inside',
    directoryExpectation: 'directory',
    candidateExpectation: 'file',
    directoryLabel: 'Encrypted backup directory',
    candidateLabel: label,
    expectedDirectoryPhysicalPath: expectedBackupPhysicalPath,
    expectedCandidatePhysicalPath: expectedPhysicalPath,
    relationshipError: `${label} must stay inside the encrypted backup directory.`,
  });
  return result.candidate;
}

const encryptedArtifactPaths = new Map();
for (const artifact of receipt.artifacts) {
  encryptedArtifactPaths.set(
    artifact.name,
    await existingBackupFile(artifact.name, 'Encrypted database artifact'),
  );
}

let recoveryKey;
let key;
if (recoveryKeyFile) {
  const serializedRecoveryKeyBytes = await readFile(path.resolve(recoveryKeyFile));
  if (serializedRecoveryKeyBytes.byteLength > 256) {
    throw new Error('Portable recovery key format is invalid.');
  }
  const serializedRecoveryKey = serializedRecoveryKeyBytes.toString('utf8');
  const recoveryKeyMatch = serializedRecoveryKey.match(
    /^SAFETYHUB-RECOVERY-KEY-V1:([A-Za-z0-9_-]{43})(?:\r?\n)?$/u,
  );
  if (!recoveryKeyMatch) throw new Error('Portable recovery key format is invalid.');
  recoveryKey = Buffer.from(recoveryKeyMatch[1], 'base64url');
  if (
    recoveryKey.byteLength !== 32 ||
    recoveryKey.toString('base64url') !== recoveryKeyMatch[1]
  ) {
    throw new Error('Portable recovery key is invalid.');
  }
  const recoveryEnvelopeLocation = await existingBackupFile(
    receipt.portableRecovery.wrappedKeyFile,
    'Portable recovery envelope',
  );
  const recoveryEnvelope = await readFile(recoveryEnvelopeLocation.absolutePath);
  if (
    createHash('sha256').update(recoveryEnvelope).digest('hex') !==
    receipt.portableRecovery.encryptedSha256
  ) {
    throw new Error('Portable recovery envelope checksum mismatch.');
  }
  const recoveryMagic = Buffer.from('SAFETYHUB-DB-KEY-V1\0');
  if (
    recoveryEnvelope.byteLength !== recoveryMagic.byteLength + 12 + 16 + 32 ||
    !recoveryEnvelope.subarray(0, recoveryMagic.byteLength).equals(recoveryMagic)
  ) {
    throw new Error('Portable recovery envelope header mismatch.');
  }
  const recoveryIv = recoveryEnvelope.subarray(
    recoveryMagic.byteLength,
    recoveryMagic.byteLength + 12,
  );
  const recoveryTag = recoveryEnvelope.subarray(
    recoveryMagic.byteLength + 12,
    recoveryMagic.byteLength + 28,
  );
  const encryptedKey = recoveryEnvelope.subarray(recoveryMagic.byteLength + 28);
  const recoveryDecipher = createDecipheriv('aes-256-gcm', recoveryKey, recoveryIv);
  recoveryDecipher.setAAD(recoveryMagic);
  recoveryDecipher.setAuthTag(recoveryTag);
  key = Buffer.concat([recoveryDecipher.update(encryptedKey), recoveryDecipher.final()]);
} else {
  const protectedKeyLocation = await existingBackupFile(
    'database-backup.key.dpapi',
    'Windows DPAPI backup key',
  );
  const protectedKey = await readFile(protectedKeyLocation.absolutePath, 'utf8');
  const cleanPowerShellEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  const unprotected = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Import-Module Microsoft.PowerShell.Security; $secure = ConvertTo-SecureString $env:SAFETYHUB_PROTECTED_BACKUP_KEY; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...cleanPowerShellEnvironment,
        SAFETYHUB_PROTECTED_BACKUP_KEY: protectedKey.trim(),
      },
    },
  );
  if (unprotected.status !== 0 || !unprotected.stdout.trim()) {
    throw new Error(
      `Windows DPAPI key recovery failed: ${unprotected.stderr.trim() || 'unknown error'}`,
    );
  }
  const encodedKey = unprotected.stdout.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encodedKey)) {
    throw new Error('Recovered backup key is invalid.');
  }
  key = Buffer.from(encodedKey, 'base64');
  if (key.toString('base64') !== encodedKey) throw new Error('Recovered backup key is invalid.');
}
if (key.byteLength !== 32) throw new Error('Recovered backup key is invalid.');

async function assertCreatedOutputDirectory() {
  return assertPhysicalPathRelationship({
    directoryPath: output,
    candidatePath: backup,
    relationship: 'outside',
    directoryExpectation: 'directory',
    candidateExpectation: 'directory',
    directoryLabel: 'Plaintext restore directory',
    candidateLabel: 'Encrypted backup directory',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    expectedCandidatePhysicalPath: expectedBackupPhysicalPath,
    relationshipError: 'The plaintext restore directory must be outside the encrypted backup directory.',
  });
}

async function assertOutputFile(outputName, expectation) {
  return assertPhysicalPathRelationship({
    directoryPath: output,
    candidatePath: path.join(output, outputName),
    relationship: 'inside',
    directoryExpectation: 'directory',
    candidateExpectation: expectation,
    directoryLabel: 'Plaintext restore directory',
    candidateLabel: 'Restored database artifact',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    relationshipError: 'A restored database artifact escaped the plaintext restore directory.',
  });
}

let outputCreated = false;
try {
  await mkdir(output, { recursive: false });
  outputCreated = true;
  await assertCreatedOutputDirectory();
  for (const artifact of receipt.artifacts) {
    const initialEnvelopeLocation = encryptedArtifactPaths.get(artifact.name);
    const envelopeLocation = await existingBackupFile(
      artifact.name,
      'Encrypted database artifact',
      initialEnvelopeLocation.physicalPath,
    );
    const envelope = await readFile(envelopeLocation.absolutePath);
    if (
      envelope.byteLength !== artifact.encryptedBytes ||
      createHash('sha256').update(envelope).digest('hex') !== artifact.encryptedSha256
    ) {
      throw new Error(`Encrypted artifact checksum mismatch: ${artifact.name}`);
    }
    const magic = Buffer.from('SAFETYHUB-DB-BACKUP-V1\0');
    if (!envelope.subarray(0, magic.byteLength).equals(magic)) {
      throw new Error(`Encrypted artifact header mismatch: ${artifact.name}`);
    }
    const iv = envelope.subarray(magic.byteLength, magic.byteLength + 12);
    const tag = envelope.subarray(magic.byteLength + 12, magic.byteLength + 28);
    const encrypted = envelope.subarray(magic.byteLength + 28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (
      plaintext.byteLength !== artifact.plaintextBytes ||
      createHash('sha256').update(plaintext).digest('hex') !== artifact.plaintextSha256
    ) {
      throw new Error(`Restored artifact checksum mismatch: ${artifact.name}`);
    }
    const outputLocation = await assertOutputFile(artifact.outputName, 'absent');
    await writeFile(outputLocation.candidate.absolutePath, plaintext, { flag: 'wx', mode: 0o600 });
    await assertOutputFile(artifact.outputName, 'file');
  }
  console.log(JSON.stringify({ ok: true, outputDirectory: output }));
} catch (error) {
  if (outputCreated) {
    try {
      await assertCreatedOutputDirectory();
      await rm(output, { recursive: true, force: true });
    } catch {
      // Do not recursively remove a path whose physical identity changed during the restore.
    }
  }
  throw error;
} finally {
  key?.fill(0);
  recoveryKey?.fill(0);
}
