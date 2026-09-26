import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { OperatorToolError } from './storage-operator-tools.mjs';
import { verifyStorageByteBackup } from './storage-byte-backup-tools.mjs';

const USAGE =
  'Usage: --backup <encrypted-run-directory> --expected-project-ref <ref> --allow-bucket <bucket> [--allow-bucket <bucket>] [--recovery-key-file <file>]';

function fail(code) {
  throw new OperatorToolError(code);
}

function requireCondition(value, code) {
  if (!value) fail(code);
}

function parseArguments(argv) {
  const allowed = new Set([
    '--backup',
    '--expected-project-ref',
    '--allow-bucket',
    '--recovery-key-file',
  ]);
  const values = Object.create(null);
  values['--allow-bucket'] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    requireCondition(allowed.has(name), 'STORAGE_BACKUP_VERIFY_CLI_UNKNOWN_ARGUMENT');
    requireCondition(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'STORAGE_BACKUP_VERIFY_CLI_ARGUMENT_VALUE_REQUIRED');
    if (name === '--allow-bucket') {
      values[name].push(value);
      continue;
    }
    requireCondition(values[name] === undefined, 'STORAGE_BACKUP_VERIFY_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
  }
  for (const required of ['--backup', '--expected-project-ref']) {
    requireCondition(typeof values[required] === 'string', 'STORAGE_BACKUP_VERIFY_CLI_REQUIRED_ARGUMENT_MISSING');
  }
  requireCondition(values['--allow-bucket'].length > 0, 'STORAGE_BACKUP_VERIFY_CLI_REQUIRED_ARGUMENT_MISSING');
  return {
    backupDirectory: values['--backup'],
    expectedProjectRef: values['--expected-project-ref'],
    buckets: values['--allow-bucket'],
    recoveryKeyFile: values['--recovery-key-file'],
  };
}

async function readPortableRecoveryKey(file) {
  let serialized;
  try {
    serialized = (await readFile(path.resolve(file), 'utf8')).trim();
  } catch {
    fail('STORAGE_BACKUP_PORTABLE_KEY_UNAVAILABLE');
  }
  const prefix = 'SAFETYHUB-STORAGE-RECOVERY-KEY-V1:';
  requireCondition(serialized.startsWith(prefix), 'STORAGE_BACKUP_PORTABLE_KEY_INVALID');
  const passphrase = serialized.slice(prefix.length);
  requireCondition(/^[A-Za-z0-9+/]{64}$/u.test(passphrase), 'STORAGE_BACKUP_PORTABLE_KEY_INVALID');
  return passphrase;
}

async function recoverDpapiPassphrase(backupDirectory) {
  if (process.platform !== 'win32') fail('STORAGE_BACKUP_DPAPI_WINDOWS_REQUIRED');
  let protectedPassphrase;
  try {
    protectedPassphrase = await readFile(
      path.join(path.resolve(backupDirectory), 'archive-passphrase.key.dpapi'),
      'utf8',
    );
  } catch {
    fail('STORAGE_BACKUP_DPAPI_KEY_UNAVAILABLE');
  }
  const cleanPowerShellEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'psmodulepath' && normalized !== 'supabase_secret_key';
    }),
  );
  const recovered = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Import-Module Microsoft.PowerShell.Security; $secure = ConvertTo-SecureString $env:SAFETYHUB_PROTECTED_STORAGE_BACKUP_KEY; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...cleanPowerShellEnvironment,
        SAFETYHUB_PROTECTED_STORAGE_BACKUP_KEY: protectedPassphrase.trim(),
      },
    },
  );
  if (recovered.status !== 0 || !recovered.stdout.trim()) fail('STORAGE_BACKUP_DPAPI_RECOVERY_FAILED');
  const passphrase = recovered.stdout.trim();
  requireCondition(/^[A-Za-z0-9+/]{64}$/u.test(passphrase), 'STORAGE_BACKUP_DPAPI_RECOVERY_FAILED');
  return passphrase;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  let archivePassphrase;
  try {
    archivePassphrase = args.recoveryKeyFile
      ? await readPortableRecoveryKey(args.recoveryKeyFile)
      : await recoverDpapiPassphrase(args.backupDirectory);
    const result = await verifyStorageByteBackup({
      backupDirectory: args.backupDirectory,
      expectedProjectRef: args.expectedProjectRef,
      buckets: args.buckets,
      archivePassphrase,
    });
    process.stdout.write(
      `${JSON.stringify({
        ...result,
        keyProtection: args.recoveryKeyFile ? 'portable-recovery-key' : 'windows-dpapi-current-user',
      })}\n`,
    );
  } finally {
    archivePassphrase = '';
  }
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main().catch((error) => {
    const code = error instanceof OperatorToolError ? error.code : 'STORAGE_BACKUP_VERIFY_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code, usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
