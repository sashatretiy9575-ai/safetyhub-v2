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

const FEATURES = new Set([
  'notification_events',
  'telegram_delivery',
  'telegram_application_details',
  'zh_username_password',
]);
const USAGE =
  'Usage: --expected-project-ref <current-production-ref> --confirm-project-ref <same-ref> --feature <notification_events|telegram_delivery|telegram_application_details|zh_username_password> --enabled <true|false> --reason <8-500 chars> --idempotency-key <new-or-retried-uuid> (--env-file <absolute-secret-env-file> | --secret-stdin)';

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
    '--feature',
    '--enabled',
    '--reason',
    '--idempotency-key',
    '--env-file',
    '--secret-stdin',
  ]);
  const values = Object.create(null);
  for (let index = 0; index < argv.length; ) {
    const name = argv[index];
    requireCondition(allowed.has(name), 'RUNTIME_FLAG_CLI_UNKNOWN_ARGUMENT');
    if (name === '--secret-stdin') {
      requireCondition(values[name] === undefined, 'RUNTIME_FLAG_CLI_DUPLICATE_ARGUMENT');
      values[name] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    requireCondition(
      typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      'RUNTIME_FLAG_CLI_ARGUMENT_VALUE_REQUIRED',
    );
    requireCondition(values[name] === undefined, 'RUNTIME_FLAG_CLI_DUPLICATE_ARGUMENT');
    values[name] = value;
    index += 2;
  }
  for (const name of [
    '--expected-project-ref',
    '--confirm-project-ref',
    '--feature',
    '--enabled',
    '--reason',
    '--idempotency-key',
  ]) {
    requireCondition(values[name] !== undefined, 'RUNTIME_FLAG_CLI_REQUIRED_ARGUMENT_MISSING');
  }
  requireCondition(
    (typeof values['--env-file'] === 'string') !== (values['--secret-stdin'] === true),
    'RUNTIME_FLAG_CREDENTIAL_SOURCE_INVALID',
  );
  requireCondition(FEATURES.has(values['--feature']), 'RUNTIME_FLAG_FEATURE_INVALID');
  requireCondition(['true', 'false'].includes(values['--enabled']), 'RUNTIME_FLAG_ENABLED_INVALID');
  if (values['--env-file'] !== undefined) {
    requireCondition(path.isAbsolute(values['--env-file']), 'RUNTIME_FLAG_ENV_FILE_PATH_INVALID');
  }
  return {
    projectRef: assertProductionMutationConfirmation(
      values['--expected-project-ref'],
      values['--confirm-project-ref'],
    ),
    featureName: values['--feature'],
    enabled: values['--enabled'] === 'true',
    reason: assertReason(values['--reason']),
    idempotencyKey: assertIdempotencyKey(values['--idempotency-key']),
    environmentFile: values['--env-file'],
    secretStdin: values['--secret-stdin'] === true,
  };
}

function validateResult(result, request) {
  requireCondition(
    result && typeof result === 'object' && !Array.isArray(result),
    'RUNTIME_FLAG_RESULT_INVALID',
  );
  requireCondition(result.featureName === request.featureName, 'RUNTIME_FLAG_RESULT_INVALID');
  requireCondition(result.enabled === request.enabled, 'RUNTIME_FLAG_RESULT_INVALID');
  requireCondition(typeof result.changed === 'boolean', 'RUNTIME_FLAG_RESULT_INVALID');
  requireCondition(
    typeof result.updatedAt === 'string' && Number.isFinite(Date.parse(result.updatedAt)),
    'RUNTIME_FLAG_RESULT_INVALID',
  );
  return {
    ok: true,
    projectRef: request.projectRef,
    featureName: result.featureName,
    enabled: result.enabled,
    changed: result.changed,
    updatedAt: result.updatedAt,
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
      rpcName: 'set_runtime_feature_flag',
      parameters: {
        p_feature_name: request.featureName,
        p_enabled: request.enabled,
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
    stdinSecret = '';
  }
}

function safeErrorCode(error) {
  if (error instanceof ProductionOperatorError || error instanceof OperatorToolError)
    return error.code;
  return 'RUNTIME_FLAG_OPERATION_FAILED';
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
