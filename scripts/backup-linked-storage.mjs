import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  OperatorToolError,
  createBoundedFetch,
  readServiceCredential,
} from './storage-operator-tools.mjs';
import { ProductionOperatorError, readRawSecretFromStdin } from './production-operator-safety.mjs';
import {
  assertRecoveryKeyOutsideOutput,
  runStorageByteBackup,
  storageServiceKeyConfig,
  validateStorageBackupRequest,
} from './storage-byte-backup-tools.mjs';

const USAGE =
  'Usage: --expected-project-ref <ref> --allow-bucket <bucket> [--allow-bucket <bucket>] --output-dir <existing-private-directory> (--env-file <env-file> | --secret-stdin) --recovery-key-output <new-file> [--page-size <1-1000>] [--request-timeout-ms <1000-120000>]';

function fail(code) {
  throw new OperatorToolError(code);
}

function requireCondition(value, code) {
  if (!value) fail(code);
}

function parseInteger(value, minimum, maximum, code) {
  requireCondition(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value), code);
  const parsed = Number(value);
  requireCondition(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum, code);
  return parsed;
}

export function parseArguments(argv) {
  const allowed = new Set([
    '--expected-project-ref',
    '--allow-bucket',
    '--output-dir',
    '--env-file',
    '--secret-stdin',
    '--recovery-key-output',
    '--page-size',
    '--request-timeout-ms',
  ]);
  const values = Object.create(null);
  values['--allow-bucket'] = [];
  for (let index = 0; index < argv.length; ) {
    const name = argv[index];
    requireCondition(allowed.has(name), 'STORAGE_BACKUP_CLI_UNKNOWN_ARGUMENT');
    if (name === '--secret-stdin') {
      requireCondition(values[name] === undefined, 'STORAGE_BACKUP_CLI_DUPLICATE_ARGUMENT');
      values[name] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    requireCondition(
      typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      'STORAGE_BACKUP_CLI_ARGUMENT_VALUE_REQUIRED',
    );
    if (name === '--allow-bucket') {
      values[name].push(value);
      index += 2;
      continue;
    }
    requireCondition(values[name] === undefined, 'STORAGE_BACKUP_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
    index += 2;
  }
  for (const required of ['--expected-project-ref', '--output-dir', '--recovery-key-output']) {
    requireCondition(
      typeof values[required] === 'string',
      'STORAGE_BACKUP_CLI_REQUIRED_ARGUMENT_MISSING',
    );
  }
  requireCondition(
    values['--allow-bucket'].length > 0,
    'STORAGE_BACKUP_CLI_REQUIRED_ARGUMENT_MISSING',
  );
  requireCondition(
    (typeof values['--env-file'] === 'string') !== (values['--secret-stdin'] === true),
    'STORAGE_BACKUP_CREDENTIAL_SOURCE_INVALID',
  );
  return {
    expectedProjectRef: values['--expected-project-ref'],
    buckets: values['--allow-bucket'],
    outputDirectory: values['--output-dir'],
    environmentFile: values['--env-file'],
    secretStdin: values['--secret-stdin'] === true,
    recoveryKeyOutput: values['--recovery-key-output'],
    pageSize:
      values['--page-size'] === undefined
        ? 100
        : parseInteger(values['--page-size'], 1, 1_000, 'STORAGE_BACKUP_CLI_PAGE_SIZE_INVALID'),
    requestTimeoutMs:
      values['--request-timeout-ms'] === undefined
        ? 30_000
        : parseInteger(
            values['--request-timeout-ms'],
            1_000,
            120_000,
            'STORAGE_BACKUP_CLI_TIMEOUT_INVALID',
          ),
  };
}

async function loadServiceCredential(args, input) {
  if (!args.secretStdin) return loadServiceCredentialFromEnvironmentFile(args.environmentFile);
  let rawSecret = '';
  try {
    rawSecret = await readRawSecretFromStdin(input);
    return readServiceCredential(storageServiceKeyConfig(), { SUPABASE_SECRET_KEY: rawSecret });
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    if (error instanceof ProductionOperatorError) throw new OperatorToolError(error.code);
    fail('STORAGE_BACKUP_STDIN_CREDENTIAL_INVALID');
  } finally {
    rawSecret = '';
  }
}

async function requireExistingRecoveryKeyParent(file) {
  let stats;
  try {
    stats = await lstat(path.dirname(file));
  } catch {
    fail('STORAGE_BACKUP_RECOVERY_KEY_PARENT_UNAVAILABLE');
  }
  requireCondition(
    stats.isDirectory() && !stats.isSymbolicLink(),
    'STORAGE_BACKUP_RECOVERY_KEY_PARENT_UNAVAILABLE',
  );
}

function loadServiceCredentialFromEnvironmentFile(environmentFile) {
  const name = 'SUPABASE_SECRET_KEY';
  const inheritedValue = process.env[name];
  try {
    // `process.loadEnvFile()` deliberately does not overwrite an inherited value.
    // The explicit --env-file must be the only credential source for this backup.
    delete process.env[name];
    try {
      process.loadEnvFile(path.resolve(environmentFile));
    } catch {
      fail('STORAGE_BACKUP_ENV_FILE_INVALID');
    }
    return readServiceCredential(storageServiceKeyConfig(), process.env);
  } finally {
    delete process.env[name];
    if (inheritedValue !== undefined) process.env[name] = inheritedValue;
  }
}

function protectPassphraseWithDpapi(passphrase) {
  const cleanPowerShellEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'psmodulepath' && normalized !== 'supabase_secret_key';
    }),
  );
  const protectedResult = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Import-Module Microsoft.PowerShell.Security; ConvertFrom-SecureString (ConvertTo-SecureString $env:SAFETYHUB_STORAGE_BACKUP_KEY -AsPlainText -Force)',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...cleanPowerShellEnvironment, SAFETYHUB_STORAGE_BACKUP_KEY: passphrase },
    },
  );
  if (protectedResult.status !== 0 || !protectedResult.stdout.trim()) {
    fail('STORAGE_BACKUP_DPAPI_PROTECTION_FAILED');
  }
  return protectedResult.stdout.trim();
}

export async function main(argv = process.argv.slice(2), { input = process.stdin } = {}) {
  const args = parseArguments(argv);
  if (process.platform !== 'win32') fail('STORAGE_BACKUP_DPAPI_WINDOWS_REQUIRED');

  const request = validateStorageBackupRequest({
    expectedProjectRef: args.expectedProjectRef,
    buckets: args.buckets,
  });
  const outputDirectory = path.resolve(args.outputDirectory);
  const recoveryKeyBoundary = await assertRecoveryKeyOutsideOutput(
    args.recoveryKeyOutput,
    outputDirectory,
  );
  const recoveryKeyOutput = recoveryKeyBoundary.recoveryKeyOutput;
  await requireExistingRecoveryKeyParent(recoveryKeyOutput);
  try {
    await lstat(recoveryKeyOutput);
    fail('STORAGE_BACKUP_RECOVERY_KEY_ALREADY_EXISTS');
  } catch (error) {
    if (error instanceof OperatorToolError) throw error;
    if (error?.code !== 'ENOENT') fail('STORAGE_BACKUP_RECOVERY_KEY_PATH_INVALID');
  }

  const serviceCredential = await loadServiceCredential(args, input);
  const passphraseBytes = randomBytes(48);
  const archivePassphrase = passphraseBytes.toString('base64');
  let runDirectory;
  let recoveryKeyWritten = false;
  try {
    const client = createClient(request.supabaseUrl, serviceCredential, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: createBoundedFetch(args.requestTimeoutMs) },
    });
    const receipt = await runStorageByteBackup({
      client,
      expectedProjectRef: request.expectedProjectRef,
      buckets: request.buckets,
      archivePassphrase,
      outputDirectory,
      repositoryRoot: fileURLToPath(new URL('..', import.meta.url)),
      pageSize: args.pageSize,
    });
    runDirectory = receipt.runDirectory;
    const protectedPassphrase = protectPassphraseWithDpapi(archivePassphrase);
    await writeFile(path.join(runDirectory, 'archive-passphrase.key.dpapi'), protectedPassphrase, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      path.join(runDirectory, 'key-recovery.json'),
      `${JSON.stringify(
        {
          kind: 'safetyhub-storage-backup-key-v1',
          protection: ['windows-dpapi-current-user', 'portable-recovery-key'],
          verified: true,
          warning: 'Store the portable recovery key separately from this backup directory.',
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await assertRecoveryKeyOutsideOutput(recoveryKeyOutput, outputDirectory, {
      expectedOutputPhysicalPath: recoveryKeyBoundary.outputPhysicalPath,
      expectedRecoveryKeyPhysicalPath: recoveryKeyBoundary.recoveryKeyPhysicalPath,
    });
    await writeFile(recoveryKeyOutput, `SAFETYHUB-STORAGE-RECOVERY-KEY-V1:${archivePassphrase}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    recoveryKeyWritten = true;
    await assertRecoveryKeyOutsideOutput(recoveryKeyOutput, outputDirectory, {
      candidateExpectation: 'file',
      expectedOutputPhysicalPath: recoveryKeyBoundary.outputPhysicalPath,
      expectedRecoveryKeyPhysicalPath: recoveryKeyBoundary.recoveryKeyPhysicalPath,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        runDirectory,
        projectRef: receipt.projectRef,
        buckets: receipt.buckets,
        archivedObjects: receipt.archivedObjects,
        archivedBytes: receipt.archivedBytes,
        archiveSha256: receipt.archiveSha256,
        keyProtection: ['windows-dpapi-current-user', 'portable-recovery-key'],
      })}\n`,
    );
  } catch (error) {
    if (runDirectory) await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
    if (recoveryKeyWritten) {
      try {
        await assertRecoveryKeyOutsideOutput(recoveryKeyOutput, outputDirectory, {
          candidateExpectation: 'file',
          expectedOutputPhysicalPath: recoveryKeyBoundary.outputPhysicalPath,
          expectedRecoveryKeyPhysicalPath: recoveryKeyBoundary.recoveryKeyPhysicalPath,
        });
        await unlink(recoveryKeyOutput);
      } catch {
        // Do not unlink a recovery-key path whose physical identity changed.
      }
    }
    if (error instanceof OperatorToolError) throw error;
    fail('STORAGE_BACKUP_FAILED');
  } finally {
    passphraseBytes.fill(0);
  }
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main().catch((error) => {
    const code = error instanceof OperatorToolError ? error.code : 'STORAGE_BACKUP_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code, usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
