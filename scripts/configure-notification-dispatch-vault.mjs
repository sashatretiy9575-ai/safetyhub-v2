import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { OperatorToolError } from './storage-operator-tools.mjs';
import {
  ProductionOperatorError,
  assertIdempotencyKey,
  assertProductionMutationConfirmation,
  assertReason,
  productionSupabaseUrl,
} from './production-operator-safety.mjs';
import {
  callProductionServiceRpc,
  readProductionServiceCredential,
} from './production-rpc-operator.mjs';

const USAGE =
  'Usage: --expected-project-ref <current-production-ref> --confirm-project-ref <same-ref> --reason <8-500 chars> --idempotency-key <new-or-retried-uuid> --env-file <absolute-secret-env-file-with-SUPABASE_SECRET_KEY-and-TELEGRAM_DISPATCHER_SECRET>';
const VAULT_NAMES = ['notification_dispatch_url', 'notification_dispatch_secret'];

function fail(code) {
  throw new ProductionOperatorError(code);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

export function parseArguments(argv) {
  const allowed = new Set([
    '--expected-project-ref',
    '--confirm-project-ref',
    '--reason',
    '--idempotency-key',
    '--env-file',
  ]);
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    requireCondition(allowed.has(name), 'VAULT_CONFIG_CLI_UNKNOWN_ARGUMENT');
    requireCondition(
      typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      'VAULT_CONFIG_CLI_ARGUMENT_VALUE_REQUIRED',
    );
    requireCondition(values[name] === undefined, 'VAULT_CONFIG_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
  }
  for (const name of allowed) {
    requireCondition(values[name] !== undefined, 'VAULT_CONFIG_CLI_REQUIRED_ARGUMENT_MISSING');
  }
  requireCondition(path.isAbsolute(values['--env-file']), 'VAULT_CONFIG_ENV_FILE_PATH_INVALID');
  return {
    projectRef: assertProductionMutationConfirmation(
      values['--expected-project-ref'],
      values['--confirm-project-ref'],
    ),
    reason: assertReason(values['--reason']),
    idempotencyKey: assertIdempotencyKey(values['--idempotency-key']),
    environmentFile: values['--env-file'],
  };
}

function validateDispatcherSecret(value) {
  requireCondition(
    typeof value === 'string' &&
      value.length >= 32 &&
      value.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !/replace|example|your-|placeholder/iu.test(value),
    'VAULT_CONFIG_DISPATCHER_SECRET_INVALID',
  );
  return value;
}

function validateResult(result, request) {
  requireCondition(
    result && typeof result === 'object' && !Array.isArray(result),
    'VAULT_CONFIG_RESULT_INVALID',
  );
  requireCondition(result.configured === true, 'VAULT_CONFIG_RESULT_INVALID');
  requireCondition(
    Array.isArray(result.vaultNames) &&
      result.vaultNames.length === VAULT_NAMES.length &&
      result.vaultNames.every((name, index) => name === VAULT_NAMES[index]),
    'VAULT_CONFIG_RESULT_INVALID',
  );
  return {
    ok: true,
    projectRef: request.projectRef,
    configured: true,
    vaultNames: VAULT_NAMES,
    idempotencyKey: request.idempotencyKey,
  };
}

export async function main(
  argv = process.argv.slice(2),
  { fetchImpl = globalThis.fetch, writeOutput = (value) => process.stdout.write(value) } = {},
) {
  const request = parseArguments(argv);
  let serviceKey = '';
  let dispatcherSecret = '';
  try {
    const loaded = await readProductionServiceCredential(request.environmentFile, [
      'TELEGRAM_DISPATCHER_SECRET',
    ]);
    serviceKey = loaded.serviceKey;
    dispatcherSecret = validateDispatcherSecret(loaded.environment.TELEGRAM_DISPATCHER_SECRET);
    const dispatchUrl = `${productionSupabaseUrl(request.projectRef)}/functions/v1/telegram-dispatcher`;
    const result = await callProductionServiceRpc({
      projectRef: request.projectRef,
      rpcName: 'configure_notification_dispatch_vault',
      parameters: {
        p_dispatch_url: dispatchUrl,
        p_dispatch_secret: dispatcherSecret,
        p_reason: request.reason,
        p_idempotency_key: request.idempotencyKey,
      },
      serviceKey,
      fetchImpl,
    });
    const summary = validateResult(result, request);
    writeOutput(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    serviceKey = '';
    dispatcherSecret = '';
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
