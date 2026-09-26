// Stores the drain URL and its bearer secret in Vault, so pg_cron can call
// POST /api/auth/send-email/drain on the production deployment every two
// minutes while a sign-in email is waiting. The secret is the same value as
// AUTH_EMAIL_DRAIN_SECRET on Vercel.
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { OperatorToolError } from '../storage/storage-operator-tools.mjs';
import {
  ProductionOperatorError,
  assertProductionMutationConfirmation,
  readExactSecretAssignmentsFromStdin,
} from '../ops/production-operator-safety.mjs';
import {
  callProductionServiceRpc,
  productionServiceCredential,
  readProductionServiceCredential,
} from '../ops/production-rpc-operator.mjs';

const USAGE =
  'Usage: --expected-project-ref <current-production-ref> --confirm-project-ref <same-ref> --site-origin https://safetyhub.kz (--env-file <absolute-secret-env-file-with-SUPABASE_SECRET_KEY-and-AUTH_EMAIL_DRAIN_SECRET> | --secret-stdin)';
export const VAULT_NAMES = Object.freeze(['auth_email_drain_url', 'auth_email_drain_secret']);
const DRAIN_PATH = '/api/auth/send-email/drain';

function fail(code) {
  throw new ProductionOperatorError(code);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

export function drainUrlForOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail('VAULT_CONFIG_SITE_ORIGIN_INVALID');
  }
  requireCondition(
    parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      /^[a-z0-9.-]+$/u.test(parsed.hostname),
    'VAULT_CONFIG_SITE_ORIGIN_INVALID',
  );
  return `${parsed.origin}${DRAIN_PATH}`;
}

export function parseArguments(argv) {
  const allowed = new Set([
    '--expected-project-ref',
    '--confirm-project-ref',
    '--site-origin',
    '--env-file',
    '--secret-stdin',
  ]);
  const values = Object.create(null);
  for (let index = 0; index < argv.length; ) {
    const name = argv[index];
    requireCondition(allowed.has(name), 'VAULT_CONFIG_CLI_UNKNOWN_ARGUMENT');
    if (name === '--secret-stdin') {
      requireCondition(values[name] === undefined, 'VAULT_CONFIG_CLI_DUPLICATE_ARGUMENT');
      values[name] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    requireCondition(
      typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      'VAULT_CONFIG_CLI_ARGUMENT_VALUE_REQUIRED',
    );
    requireCondition(values[name] === undefined, 'VAULT_CONFIG_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
    index += 2;
  }
  for (const name of ['--expected-project-ref', '--confirm-project-ref', '--site-origin']) {
    requireCondition(values[name] !== undefined, 'VAULT_CONFIG_CLI_REQUIRED_ARGUMENT_MISSING');
  }
  requireCondition(
    (typeof values['--env-file'] === 'string') !== (values['--secret-stdin'] === true),
    'VAULT_CONFIG_CREDENTIAL_SOURCE_INVALID',
  );
  if (values['--env-file'] !== undefined) {
    requireCondition(path.isAbsolute(values['--env-file']), 'VAULT_CONFIG_ENV_FILE_PATH_INVALID');
  }
  return {
    projectRef: assertProductionMutationConfirmation(
      values['--expected-project-ref'],
      values['--confirm-project-ref'],
    ),
    drainUrl: drainUrlForOrigin(values['--site-origin']),
    environmentFile: values['--env-file'],
    secretStdin: values['--secret-stdin'] === true,
  };
}

function validateDrainSecret(value) {
  requireCondition(
    typeof value === 'string' &&
      value.length >= 32 &&
      value.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !/replace|example|your-|placeholder/iu.test(value),
    'VAULT_CONFIG_DRAIN_SECRET_INVALID',
  );
  return value;
}

function validateResult(result, request) {
  requireCondition(
    result && typeof result === 'object' && !Array.isArray(result) && result.configured === true,
    'VAULT_CONFIG_RESULT_INVALID',
  );
  return {
    ok: true,
    projectRef: request.projectRef,
    configured: true,
    drainUrl: request.drainUrl,
    vaultNames: [...VAULT_NAMES],
  };
}

export async function main(
  argv = process.argv.slice(2),
  {
    fetchImpl = globalThis.fetch,
    input = process.stdin,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  const request = parseArguments(argv);
  let serviceKey = '';
  let drainSecret = '';
  try {
    const loaded = request.secretStdin
      ? productionServiceCredential(
          await readExactSecretAssignmentsFromStdin(
            ['SUPABASE_SECRET_KEY', 'AUTH_EMAIL_DRAIN_SECRET'],
            input,
          ),
        )
      : await readProductionServiceCredential(request.environmentFile, [
          'AUTH_EMAIL_DRAIN_SECRET',
        ]);
    serviceKey = loaded.serviceKey;
    drainSecret = validateDrainSecret(loaded.environment.AUTH_EMAIL_DRAIN_SECRET);
    const result = await callProductionServiceRpc({
      projectRef: request.projectRef,
      rpcName: 'configure_auth_email_drain_vault',
      parameters: { p_drain_url: request.drainUrl, p_drain_secret: drainSecret },
      serviceKey,
      fetchImpl,
    });
    const summary = validateResult(result, request);
    writeOutput(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    serviceKey = '';
    drainSecret = '';
  }
}

function safeErrorCode(error) {
  if (error instanceof ProductionOperatorError || error instanceof OperatorToolError)
    return error.code;
  return 'VAULT_CONFIG_OPERATION_FAILED';
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
