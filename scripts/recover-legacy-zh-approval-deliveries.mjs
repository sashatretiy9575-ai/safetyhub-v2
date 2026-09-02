import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { OperatorToolError } from './storage-operator-tools.mjs';
import {
  ProductionOperatorError,
  assertIdempotencyKey,
  assertProductionMutationConfirmation,
  assertReason,
  readRawSecretFromStdin,
} from './production-operator-safety.mjs';
import {
  callProductionServiceRpc,
  productionServiceCredential,
  readProductionServiceCredential,
} from './production-rpc-operator.mjs';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 100;
const RPC_NAME = 'recover_legacy_blank_zh_approval_deliveries';
const RECEIPT_OPERATION = 'legacy_zh_approval_delivery_recovery';
const USAGE =
  'Usage: --expected-project-ref <current-production-ref> --confirm-project-ref <same-ref> --reason <8-500 chars> --idempotency-key <new-or-retried-uuid> [--limit <1-100>] (--env-file <absolute-secret-env-file-with-SUPABASE_SECRET_KEY> | --secret-stdin)';

function fail(code) {
  throw new ProductionOperatorError(code);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

function parseLimit(value) {
  requireCondition(
    typeof value === 'string' && /^(?:[1-9]|[1-9][0-9]|100)$/u.test(value),
    'LEGACY_ZH_RECOVERY_LIMIT_INVALID',
  );
  const limit = Number(value);
  requireCondition(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT,
    'LEGACY_ZH_RECOVERY_LIMIT_INVALID',
  );
  return limit;
}

export function parseArguments(argv) {
  const allowed = new Set([
    '--expected-project-ref',
    '--confirm-project-ref',
    '--reason',
    '--idempotency-key',
    '--limit',
    '--env-file',
    '--secret-stdin',
  ]);
  const values = Object.create(null);

  for (let index = 0; index < argv.length; ) {
    const name = argv[index];
    requireCondition(allowed.has(name), 'LEGACY_ZH_RECOVERY_CLI_UNKNOWN_ARGUMENT');
    if (name === '--secret-stdin') {
      requireCondition(values[name] === undefined, 'LEGACY_ZH_RECOVERY_CLI_DUPLICATE_ARGUMENT');
      values[name] = true;
      index += 1;
      continue;
    }

    const value = argv[index + 1];
    requireCondition(
      typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      'LEGACY_ZH_RECOVERY_CLI_ARGUMENT_VALUE_REQUIRED',
    );
    requireCondition(values[name] === undefined, 'LEGACY_ZH_RECOVERY_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
    index += 2;
  }

  for (const name of [
    '--expected-project-ref',
    '--confirm-project-ref',
    '--reason',
    '--idempotency-key',
  ]) {
    requireCondition(
      values[name] !== undefined,
      'LEGACY_ZH_RECOVERY_CLI_REQUIRED_ARGUMENT_MISSING',
    );
  }
  requireCondition(
    (typeof values['--env-file'] === 'string') !== (values['--secret-stdin'] === true),
    'LEGACY_ZH_RECOVERY_CREDENTIAL_SOURCE_INVALID',
  );
  if (values['--env-file'] !== undefined) {
    requireCondition(
      path.isAbsolute(values['--env-file']),
      'LEGACY_ZH_RECOVERY_ENV_FILE_PATH_INVALID',
    );
  }

  return {
    projectRef: assertProductionMutationConfirmation(
      values['--expected-project-ref'],
      values['--confirm-project-ref'],
    ),
    reason: assertReason(values['--reason']),
    idempotencyKey: assertIdempotencyKey(values['--idempotency-key']),
    limit: values['--limit'] === undefined ? DEFAULT_LIMIT : parseLimit(values['--limit']),
    environmentFile: values['--env-file'],
    secretStdin: values['--secret-stdin'] === true,
  };
}

export function validateResult(result, request) {
  requireCondition(
    result && typeof result === 'object' && !Array.isArray(result),
    'LEGACY_ZH_RECOVERY_RESULT_INVALID',
  );
  const keys = Object.keys(result);
  requireCondition(
    keys.length === 1 && keys[0] === 'recovered',
    'LEGACY_ZH_RECOVERY_RESULT_INVALID',
  );
  requireCondition(
    Number.isSafeInteger(result.recovered) &&
      result.recovered >= 0 &&
      result.recovered <= request.limit,
    'LEGACY_ZH_RECOVERY_RESULT_INVALID',
  );

  return {
    ok: true,
    projectRef: request.projectRef,
    operation: RECEIPT_OPERATION,
    limit: request.limit,
    recovered: result.recovered,
    idempotencyKey: request.idempotencyKey,
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
  let stdinSecret = '';
  try {
    if (request.secretStdin) {
      stdinSecret = await readRawSecretFromStdin(input);
      ({ serviceKey } = productionServiceCredential({ SUPABASE_SECRET_KEY: stdinSecret }));
    } else {
      ({ serviceKey } = await readProductionServiceCredential(request.environmentFile));
    }

    const result = await callProductionServiceRpc({
      projectRef: request.projectRef,
      rpcName: RPC_NAME,
      parameters: { p_limit: request.limit },
      serviceKey,
      fetchImpl,
    });
    const receipt = validateResult(result, request);
    writeOutput(`${JSON.stringify(receipt)}\n`);
    return receipt;
  } finally {
    serviceKey = '';
    stdinSecret = '';
  }
}

function safeErrorCode(error) {
  if (error instanceof ProductionOperatorError || error instanceof OperatorToolError)
    return error.code;
  return 'LEGACY_ZH_RECOVERY_OPERATION_FAILED';
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
