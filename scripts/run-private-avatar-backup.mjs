import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { main as exportPrivateAvatarBackup } from './export-private-avatar-backup.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const config = args.get('--config');
const productionRef = args.get('--confirm-production-ref');
const outputDirectory = args.get('--output-dir');
const environmentFile = args.get('--env-file');
const recoveryKeyOutput = args.get('--recovery-key-output');
if (!config || !productionRef || !outputDirectory || !environmentFile || !recoveryKeyOutput) {
  console.error(
    'Usage: --config <config.json> --confirm-production-ref <ref> --output-dir <private-dir> --env-file <env-file> --recovery-key-output <new-file>',
  );
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('This backup wrapper currently requires Windows DPAPI.');
  process.exit(1);
}

process.loadEnvFile(path.resolve(environmentFile));
const resolvedOutputDirectory = path.resolve(outputDirectory);
const resolvedRecoveryKeyOutput = path.resolve(recoveryKeyOutput);
if (
  resolvedRecoveryKeyOutput === resolvedOutputDirectory ||
  resolvedRecoveryKeyOutput.startsWith(`${resolvedOutputDirectory}${path.sep}`)
) {
  console.error('The portable recovery key must be stored outside the backup directory.');
  process.exit(1);
}
const passphraseBytes = randomBytes(48);
const passphrase = passphraseBytes.toString('base64');
const environment = {
  ...process.env,
  STORAGE_BACKUP_ARCHIVE_PASSPHRASE: passphrase,
};
let runDirectory;
let recoveryKeyWritten = false;

try {
  const receipt = await exportPrivateAvatarBackup(
    [
      '--config',
      config,
      '--confirm-production-ref',
      productionRef,
      '--output-dir',
      outputDirectory,
    ],
    environment,
  );
  runDirectory = path.resolve(outputDirectory, receipt.runDirectoryName);
  if (path.dirname(runDirectory) !== path.resolve(outputDirectory)) {
    throw new Error('Backup returned an unexpected output path.');
  }

  const cleanPowerShellEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  const protectedKey = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Import-Module Microsoft.PowerShell.Security; ConvertFrom-SecureString (ConvertTo-SecureString $env:SAFETYHUB_AVATAR_BACKUP_KEY -AsPlainText -Force)',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...cleanPowerShellEnvironment, SAFETYHUB_AVATAR_BACKUP_KEY: passphrase },
    },
  );
  if (protectedKey.status !== 0 || !protectedKey.stdout.trim()) {
    throw new Error('Windows DPAPI passphrase protection failed.');
  }

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
        SAFETYHUB_PROTECTED_AVATAR_KEY: protectedKey.stdout.trim(),
      },
    },
  );
  if (recovered.status !== 0 || recovered.stdout.trim() !== passphrase) {
    throw new Error('Windows DPAPI passphrase verification failed.');
  }

  await writeFile(
    path.join(runDirectory, 'archive-passphrase.key.dpapi'),
    protectedKey.stdout.trim(),
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    path.join(runDirectory, 'key-recovery.json'),
    `${JSON.stringify(
      {
        kind: 'safetyhub-avatar-backup-key-v1',
        protection: ['windows-dpapi-current-user', 'portable-recovery-key'],
        verified: true,
        warning: 'Store the portable recovery key separately from this backup directory.',
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(resolvedRecoveryKeyOutput, `SAFETYHUB-AVATAR-RECOVERY-KEY-V1:${passphrase}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  recoveryKeyWritten = true;
  console.log(
    JSON.stringify({
      ok: true,
      runDirectory,
      archivedObjects: receipt.archivedObjects,
      archivedBytes: receipt.archivedBytes,
      keyProtection: ['windows-dpapi-current-user', 'portable-recovery-key'],
    }),
  );
} catch (error) {
  if (runDirectory) await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
  if (recoveryKeyWritten) await unlink(resolvedRecoveryKeyOutput).catch(() => {});
  console.error(error instanceof Error ? error.message : 'Avatar backup failed.');
  process.exitCode = 1;
} finally {
  passphraseBytes.fill(0);
  environment.STORAGE_BACKUP_ARCHIVE_PASSPHRASE = '';
}
