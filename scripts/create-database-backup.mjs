import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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
if (sourcePaths.some((source) => source.startsWith(`${resolvedOutput}${path.sep}`))) {
  console.error('Plaintext dump files must be outside the encrypted output directory.');
  process.exit(1);
}
if (
  resolvedRecoveryKeyOutput === resolvedOutput ||
  resolvedRecoveryKeyOutput.startsWith(`${resolvedOutput}${path.sep}`)
) {
  console.error('The portable recovery key must be stored outside the encrypted backup directory.');
  process.exit(1);
}

await mkdir(resolvedOutput, { recursive: false });
const key = randomBytes(32);
const recoveryKey = randomBytes(32);
let recoveryKeyWritten = false;
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

if (process.platform !== 'win32') {
  console.error('This backup wrapper currently requires Windows DPAPI.');
  process.exit(1);
}

try {
  for (const sourcePath of sourcePaths) {
    const plaintext = await readFile(sourcePath);
    if (plaintext.byteLength < 128) throw new Error(`Dump is unexpectedly small: ${sourcePath}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const outputName = `${path.basename(sourcePath)}.aes256gcm`;
    const envelope = Buffer.concat([Buffer.from('SAFETYHUB-DB-BACKUP-V1\0'), iv, tag, encrypted]);
    await writeFile(path.join(resolvedOutput, outputName), envelope, { flag: 'wx', mode: 0o600 });
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
  await writeFile(
    path.join(resolvedOutput, 'database-backup.key.dpapi'),
    protectedKey.stdout.trim(),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
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
  await writeFile(path.join(resolvedOutput, recoveryEnvelopeName), recoveryEnvelope, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    resolvedRecoveryKeyOutput,
    `SAFETYHUB-RECOVERY-KEY-V1:${recoveryKey.toString('base64url')}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  recoveryKeyWritten = true;
  receipt.portableRecovery = {
    algorithm: 'aes-256-gcm',
    wrappedKeyFile: recoveryEnvelopeName,
    encryptedSha256: createHash('sha256').update(recoveryEnvelope).digest('hex'),
    recoveryKeyFormat: 'SAFETYHUB-RECOVERY-KEY-V1',
  };
  await writeFile(
    path.join(resolvedOutput, 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );

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
  if (recoveryKeyWritten) await unlink(resolvedRecoveryKeyOutput).catch(() => undefined);
  await rm(resolvedOutput, { recursive: true, force: true }).catch(() => undefined);
  console.error(error instanceof Error ? error.message : 'Database backup encryption failed.');
  process.exit(1);
} finally {
  key.fill(0);
  recoveryKey.fill(0);
}
