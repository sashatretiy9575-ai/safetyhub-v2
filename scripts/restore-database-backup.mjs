import { createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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
await mkdir(output, { recursive: false });
const receipt = JSON.parse(await readFile(path.join(backup, 'receipt.json'), 'utf8'));
if (receipt.kind !== 'safetyhub-database-backup-v1' || !Array.isArray(receipt.artifacts)) {
  throw new Error('Unsupported database backup receipt.');
}
let recoveryKey;
let key;
if (recoveryKeyFile) {
  if (!receipt.portableRecovery) throw new Error('This backup has no portable recovery envelope.');
  const serializedRecoveryKey = (await readFile(path.resolve(recoveryKeyFile), 'utf8')).trim();
  const recoveryPrefix = 'SAFETYHUB-RECOVERY-KEY-V1:';
  if (!serializedRecoveryKey.startsWith(recoveryPrefix)) {
    throw new Error('Portable recovery key format is invalid.');
  }
  recoveryKey = Buffer.from(serializedRecoveryKey.slice(recoveryPrefix.length), 'base64url');
  if (recoveryKey.byteLength !== 32) throw new Error('Portable recovery key is invalid.');
  const recoveryEnvelope = await readFile(
    path.join(backup, receipt.portableRecovery.wrappedKeyFile),
  );
  if (
    createHash('sha256').update(recoveryEnvelope).digest('hex') !==
    receipt.portableRecovery.encryptedSha256
  ) {
    throw new Error('Portable recovery envelope checksum mismatch.');
  }
  const recoveryMagic = Buffer.from('SAFETYHUB-DB-KEY-V1\0');
  if (!recoveryEnvelope.subarray(0, recoveryMagic.byteLength).equals(recoveryMagic)) {
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
  const protectedKey = await readFile(path.join(backup, 'database-backup.key.dpapi'), 'utf8');
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
  key = Buffer.from(unprotected.stdout.trim(), 'base64');
}
if (key.byteLength !== 32) throw new Error('Recovered backup key is invalid.');

try {
  for (const artifact of receipt.artifacts) {
    const envelope = await readFile(path.join(backup, artifact.name));
    if (createHash('sha256').update(envelope).digest('hex') !== artifact.encryptedSha256) {
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
    await writeFile(path.join(output, artifact.name.replace(/[.]aes256gcm$/u, '')), plaintext, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(JSON.stringify({ ok: true, outputDirectory: output }));
} catch (error) {
  await rm(output, { recursive: true, force: true }).catch(() => undefined);
  throw error;
} finally {
  key.fill(0);
  recoveryKey?.fill(0);
}
