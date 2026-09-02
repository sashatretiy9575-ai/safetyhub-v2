import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_LIMIT,
  main,
  parseArguments,
  validateResult,
} from '../../scripts/recover-legacy-zh-approval-deliveries.mjs';
import { CURRENT_PRODUCTION_PROJECT_REF } from '../../scripts/production-operator-safety.mjs';

const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';
const SERVICE_KEY = `sb_secret_${'a'.repeat(48)}`;

function baseArguments(extra = []) {
  return [
    '--expected-project-ref',
    CURRENT_PRODUCTION_PROJECT_REF,
    '--confirm-project-ref',
    CURRENT_PRODUCTION_PROJECT_REF,
    '--reason',
    'Recover exact legacy blank-ZH delivery rows only',
    '--idempotency-key',
    IDEMPOTENCY_KEY,
    ...extra,
  ];
}

test('legacy-ZH recovery CLI requires a confirmed production target and a bounded limit', () => {
  const defaultRequest = parseArguments(baseArguments(['--secret-stdin']));
  assert.equal(defaultRequest.projectRef, CURRENT_PRODUCTION_PROJECT_REF);
  assert.equal(defaultRequest.limit, DEFAULT_LIMIT);
  assert.equal(defaultRequest.secretStdin, true);

  const explicitRequest = parseArguments(
    baseArguments([
      '--limit',
      '7',
      '--env-file',
      path.resolve('secure-operator', 'production-service.env'),
    ]),
  );
  assert.equal(explicitRequest.limit, 7);
  assert.equal(explicitRequest.secretStdin, false);
  assert.equal(
    explicitRequest.environmentFile,
    path.resolve('secure-operator', 'production-service.env'),
  );

  for (const invalidLimit of ['0', '101', '01', '1.0', '-1']) {
    assert.throws(
      () => parseArguments(baseArguments(['--limit', invalidLimit, '--secret-stdin'])),
      /LEGACY_ZH_RECOVERY_LIMIT_INVALID/u,
    );
  }
  assert.throws(
    () =>
      parseArguments(baseArguments(['--env-file', path.resolve('operator.env'), '--secret-stdin'])),
    /LEGACY_ZH_RECOVERY_CREDENTIAL_SOURCE_INVALID/u,
  );
  assert.throws(
    () =>
      parseArguments([
        '--expected-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--confirm-project-ref',
        'aaaaaaaaaaaaaaaaaaaa',
        '--reason',
        'Recover exact legacy blank-ZH delivery rows only',
        '--idempotency-key',
        IDEMPOTENCY_KEY,
        '--secret-stdin',
      ]),
    /OPERATOR_PROJECT_REF_CONFIRMATION_MISMATCH/u,
  );
});

test('legacy-ZH recovery invokes only the bounded recovery RPC and emits an aggregate-only receipt', async () => {
  let observedUrl = '';
  let observedRequest;
  let output = '';
  const receipt = await main(baseArguments(['--limit', '7', '--secret-stdin']), {
    input: Readable.from([SERVICE_KEY]),
    fetchImpl: async (url, request) => {
      observedUrl = String(url);
      observedRequest = request;
      return new Response(JSON.stringify({ recovered: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    writeOutput: (value) => {
      output += value;
    },
  });

  assert.equal(
    observedUrl,
    `https://${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co/rest/v1/rpc/recover_legacy_blank_zh_approval_deliveries`,
  );
  assert.equal(observedRequest.method, 'POST');
  assert.deepEqual(JSON.parse(observedRequest.body), { p_limit: 7 });
  assert.deepEqual(receipt, {
    ok: true,
    projectRef: CURRENT_PRODUCTION_PROJECT_REF,
    operation: 'legacy_zh_approval_delivery_recovery',
    limit: 7,
    recovered: 2,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.deepEqual(JSON.parse(output), receipt);
  assert.equal(output.includes(SERVICE_KEY), false);
  assert.equal(output.includes('Recover exact legacy blank-ZH delivery rows only'), false);
});

test('legacy-ZH recovery rejects malformed or over-bounded RPC results before writing a receipt', () => {
  const request = parseArguments(baseArguments(['--limit', '7', '--secret-stdin']));
  for (const result of [
    null,
    [],
    {},
    { recovered: -1 },
    { recovered: 8 },
    { recovered: 1, eventId: 'must-not-be-emitted' },
  ]) {
    assert.throws(() => validateResult(result, request), /LEGACY_ZH_RECOVERY_RESULT_INVALID/u);
  }
});

test('recovery package command and operator documentation preserve the service-only safety boundary', async () => {
  const [source, packageSource, operations, notifications] = await Promise.all([
    readFile('scripts/recover-legacy-zh-approval-deliveries.mjs', 'utf8'),
    readFile('package.json', 'utf8'),
    readFile('docs/operations.md', 'utf8'),
    readFile('docs/notifications-and-telegram.md', 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['notifications:legacy-zh:recover'],
    'node scripts/recover-legacy-zh-approval-deliveries.mjs',
  );
  assert.match(source, /assertProductionMutationConfirmation/u);
  assert.match(source, /assertReason/u);
  assert.match(source, /assertIdempotencyKey/u);
  assert.match(source, /readRawSecretFromStdin/u);
  assert.match(source, /readProductionServiceCredential/u);
  assert.match(source, /rpcName: RPC_NAME/u);
  assert.match(source, /parameters: \{ p_limit: request\.limit \}/u);
  assert.doesNotMatch(source, /notification_deliveries|notification_events|from\(/u);
  assert.match(operations, /notifications:legacy-zh:recover/u);
  assert.match(notifications, /notifications:legacy-zh:recover/u);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:serviceKey|stdinSecret|reason)/u);
});
