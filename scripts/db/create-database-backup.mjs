import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  assertPhysicalPathRelationship,
  databaseBackupArtifactName,
  validateDatabaseBackupReceipt,
} from './database-backup-security.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const schemaPath = args.get('--schema');
const dataPath = args.get('--data');
const outputDirectory = args.get('--output');
const recoveryKeyOutput = args.get('--recovery-key-output');
if (!schemaPath || !dataPath || !outputDirectory || !recoveryKeyOutput) {
  console.error(
    'Usage: --schema <schema.dump> --data <data.dump> --output <directory> --recovery-key-output <new-file>',
  );
  process.exit(1);
}

const resolvedOutput = path.resolve(outputDirectory);
const resolvedRecoveryKeyOutput = path.resolve(recoveryKeyOutput);
const sourcePaths = [path.resolve(schemaPath), path.resolve(dataPath)];
if (process.platform !== 'win32') {
  console.error('This backup wrapper currently requires Windows DPAPI.');
  process.exit(1);
}

const artifactNames = sourcePaths.map(databaseBackupArtifactName);
if (new Set(artifactNames.map((name) => name.normalize('NFC').toUpperCase())).size !== 2) {
  throw new Error('Plaintext dump filenames would collide in the encrypted backup directory.');
}

const initialOutputBoundary = await assertPhysicalPathRelationship({
  directoryPath: resolvedOutput,
  candidatePath: resolvedRecoveryKeyOutput,
  relationship: 'outside',
  directoryExpectation: 'absent',
  candidateExpectation: 'absent',
  directoryLabel: 'Encrypted backup directory',
  candidateLabel: 'Portable recovery key output',
  relationshipError: 'The portable recovery key must be stored outside the encrypted backup directory.',
});
const expectedOutputPhysicalPath = initialOutputBoundary.directory.physicalPath;
const expectedRecoveryKeyPhysicalPath = initialOutputBoundary.candidate.physicalPath;
for (const sourcePath of sourcePaths) {
  await assertPhysicalPathRelationship({
    directoryPath: resolvedOutput,
    candidatePath: sourcePath,
    relationship: 'outside',
    directoryExpectation: 'absent',
    candidateExpectation: 'file',
    directoryLabel: 'Encrypted backup directory',
    candidateLabel: 'Plaintext dump file',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    relationshipError: 'Plaintext dump files must be outside the encrypted output directory.',
  });
}

async function assertCreatedOutputBoundary(candidatePath, candidateExpectation, candidateLabel) {
  return assertPhysicalPathRelationship({
    directoryPath: resolvedOutput,
    candidatePath,
    relationship: 'inside',
    directoryExpectation: 'directory',
    candidateExpectation,
    directoryLabel: 'Encrypted backup directory',
    candidateLabel,
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    relationshipError: `${candidateLabel} must stay inside the encrypted backup directory.`,
  });
}

async function writeNewOutputFile(name, value) {
  const target = path.join(resolvedOutput, name);
  await assertCreatedOutputBoundary(target, 'absent', 'Encrypted backup file');
  await writeFile(target, value, { flag: 'wx', mode: 0o600 });
}

async function assertCreatedOutputDirectory() {
  return assertPhysicalPathRelationship({
    directoryPath: resolvedOutput,
    candidatePath: path.dirname(resolvedOutput),
    relationship: 'outside',
    directoryExpectation: 'directory',
    candidateExpectation: 'directory',
    directoryLabel: 'Encrypted backup directory',
    candidateLabel: 'Encrypted backup parent directory',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    relationshipError: 'The encrypted backup directory changed during the operation.',
  });
}

const key = randomBytes(32);
const recoveryKey = randomBytes(32);
let recoveryKeyWritten = false;
let outputCreated = false;
const cleanPowerShellEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
);
const receipt = {
  kind: 'safetyhub-database-backup-v1',
  createdAt: new Date().toISOString(),
  cipher: 'aes-256-gcm',
  keyProtection: ['windows-dpapi-current-user', 'portable-recovery-key-aes-256-gcm'],
  artifacts: [],
};

try {
  await mkdir(resolvedOutput, { recursive: false });
  outputCreated = true;
  await assertCreatedOutputDirectory();
  await assertPhysicalPathRelationship({
    directoryPath: resolvedOutput,
    candidatePath: resolvedRecoveryKeyOutput,
    relationship: 'outside',
    directoryExpectation: 'directory',
    candidateExpectation: 'absent',
    directoryLabel: 'Encrypted backup directory',
    candidateLabel: 'Portable recovery key output',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    expectedCandidatePhysicalPath: expectedRecoveryKeyPhysicalPath,
    relationshipError:
      'The portable recovery key must be stored outside the encrypted backup directory.',
  });
  for (const sourcePath of sourcePaths) {
    await assertPhysicalPathRelationship({
      directoryPath: resolvedOutput,
      candidatePath: sourcePath,
      relationship: 'outside',
      directoryExpectation: 'directory',
      candidateExpectation: 'file',
      directoryLabel: 'Encrypted backup directory',
      candidateLabel: 'Plaintext dump file',
      expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
      relationshipError: 'Plaintext dump files must be outside the encrypted output directory.',
    });
  }
  for (const [sourceIndex, sourcePath] of sourcePaths.entries()) {
    await assertPhysicalPathRelationship({
      directoryPath: resolvedOutput,
      candidatePath: sourcePath,
      relationship: 'outside',
      directoryExpectation: 'directory',
      candidateExpectation: 'file',
      directoryLabel: 'Encrypted backup directory',
      candidateLabel: 'Plaintext dump file',
      expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
      relationshipError: 'Plaintext dump files must be outside the encrypted output directory.',
    });
    const plaintext = await readFile(sourcePath);
    if (plaintext.byteLength < 128) throw new Error(`Dump is unexpectedly small: ${sourcePath}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const outputName = artifactNames[sourceIndex];
    const envelope = Buffer.concat([Buffer.from('SAFETYHUB-DB-BACKUP-V1\0'), iv, tag, encrypted]);
    await writeNewOutputFile(outputName, envelope);
    receipt.artifacts.push({
      name: outputName,
      plaintextBytes: plaintext.byteLength,
      plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
      encryptedBytes: envelope.byteLength,
      encryptedSha256: createHash('sha256').update(envelope).digest('hex'),
    });
  }

  const protectedKey = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Import-Module Microsoft.PowerShell.Security; ConvertFrom-SecureString (ConvertTo-SecureString $env:SAFETYHUB_BACKUP_KEY -AsPlainText -Force)',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...cleanPowerShellEnvironment, SAFETYHUB_BACKUP_KEY: key.toString('base64') },
    },
  );
  if (protectedKey.status !== 0 || !protectedKey.stdout.trim()) {
    throw new Error(
      `Windows DPAPI key protection failed: ${protectedKey.stderr.trim() || 'unknown error'}`,
    );
  }
  await writeNewOutputFile('database-backup.key.dpapi', protectedKey.stdout.trim());
  const recoveryMagic = Buffer.from('SAFETYHUB-DB-KEY-V1\0');
  const recoveryIv = randomBytes(12);
  const recoveryCipher = createCipheriv('aes-256-gcm', recoveryKey, recoveryIv);
  recoveryCipher.setAAD(recoveryMagic);
  const encryptedKey = Buffer.concat([recoveryCipher.update(key), recoveryCipher.final()]);
  const recoveryEnvelope = Buffer.concat([
    recoveryMagic,
    recoveryIv,
    recoveryCipher.getAuthTag(),
    encryptedKey,
  ]);
  const recoveryEnvelopeName = 'database-backup.key.recovery.aes256gcm';
  await writeNewOutputFile(recoveryEnvelopeName, recoveryEnvelope);
  await assertPhysicalPathRelationship({
    directoryPath: resolvedOutput,
    candidatePath: resolvedRecoveryKeyOutput,
    relationship: 'outside',
    directoryExpectation: 'directory',
    candidateExpectation: 'absent',
    directoryLabel: 'Encrypted backup directory',
    candidateLabel: 'Portable recovery key output',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    expectedCandidatePhysicalPath: expectedRecoveryKeyPhysicalPath,
    relationshipError: 'The portable recovery key must be stored outside the encrypted backup directory.',
  });
  await writeFile(
    resolvedRecoveryKeyOutput,
    `SAFETYHUB-RECOVERY-KEY-V1:${recoveryKey.toString('base64url')}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  recoveryKeyWritten = true;
  await assertPhysicalPathRelationship({
    directoryPath: resolvedOutput,
    candidatePath: resolvedRecoveryKeyOutput,
    relationship: 'outside',
    directoryExpectation: 'directory',
    candidateExpectation: 'file',
    directoryLabel: 'Encrypted backup directory',
    candidateLabel: 'Portable recovery key output',
    expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
    expectedCandidatePhysicalPath: expectedRecoveryKeyPhysicalPath,
    relationshipError:
      'The portable recovery key must be stored outside the encrypted backup directory.',
  });
  receipt.portableRecovery = {
    algorithm: 'aes-256-gcm',
    wrappedKeyFile: recoveryEnvelopeName,
    encryptedSha256: createHash('sha256').update(recoveryEnvelope).digest('hex'),
    recoveryKeyFormat: 'SAFETYHUB-RECOVERY-KEY-V1',
  };
  validateDatabaseBackupReceipt(receipt);
  await writeNewOutputFile('receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);

  for (const sourcePath of sourcePaths) await unlink(sourcePath);
  console.log(
    JSON.stringify({
      ok: true,
      outputDirectory: resolvedOutput,
      portableRecovery: true,
      artifacts: receipt.artifacts.map(({ name, encryptedBytes }) => ({ name, encryptedBytes })),
    }),
  );
} catch (error) {
  if (recoveryKeyWritten) {
    try {
      await assertPhysicalPathRelationship({
        directoryPath: resolvedOutput,
        candidatePath: resolvedRecoveryKeyOutput,
        relationship: 'outside',
        directoryExpectation: 'directory',
        candidateExpectation: 'file',
        directoryLabel: 'Encrypted backup directory',
        candidateLabel: 'Portable recovery key output',
        expectedDirectoryPhysicalPath: expectedOutputPhysicalPath,
        expectedCandidatePhysicalPath: expectedRecoveryKeyPhysicalPath,
        relationshipError:
          'The portable recovery key must be stored outside the encrypted backup directory.',
      });
      await unlink(resolvedRecoveryKeyOutput);
    } catch {
      // Do not unlink a recovery-key path whose physical identity changed during the backup.
    }
  }
  if (outputCreated) {
    try {
      await assertCreatedOutputDirectory();
      await rm(resolvedOutput, { recursive: true, force: true });
    } catch {
      // Do not recursively remove a path whose physical identity changed during the backup.
    }
  }
  console.error(error instanceof Error ? error.message : 'Database backup encryption failed.');
  process.exit(1);
} finally {
  key.fill(0);
  recoveryKey.fill(0);
}
