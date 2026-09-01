import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main as configureVault } from '../../scripts/configure-notification-dispatch-vault.mjs';
import { CURRENT_PRODUCTION_PROJECT_REF } from '../../scripts/production-operator-safety.mjs';
import {
  main as setRuntimeFlag,
  parseArguments as parseRuntimeFlagArguments,
} from '../../scripts/set-runtime-feature-flag.mjs';

const SERVICE_KEY = `sb_secret_${'s'.repeat(48)}`;
const DISPATCHER_SECRET = `dispatcher-${'d'.repeat(40)}`;
const REASON = 'Reviewed production release operator test';

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mutationArguments(idempotencyKey) {
  return [
    '--expected-project-ref',
    CURRENT_PRODUCTION_PROJECT_REF,
    '--confirm-project-ref',
    CURRENT_PRODUCTION_PROJECT_REF,
    '--reason',
    REASON,
    '--idempotency-key',
    idempotencyKey,
  ];
}

function commonArguments(environmentFile, idempotencyKey) {
  return [...mutationArguments(idempotencyKey), '--env-file', environmentFile];
}

test('runtime flag CLI binds current production, uses service RPC, and emits a nonsecret receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-runtime-operator-test-'));
  try {
    const environmentFile = path.join(root, 'operator.env');
    await writeFile(environmentFile, `SUPABASE_SECRET_KEY=${SERVICE_KEY}\n`, { mode: 0o600 });
    const calls = [];
    let output = '';
    const idempotencyKey = '9b000000-0000-4000-8000-000000000001';
    const result = await setRuntimeFlag(
      [
        ...commonArguments(environmentFile, idempotencyKey),
        '--feature',
        'notification_events',
        '--enabled',
        'true',
      ],
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return response({
            featureName: 'notification_events',
            enabled: true,
            changed: true,
            updatedAt: '2026-09-02T00:00:00.000Z',
          });
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );

    assert.equal(result.enabled, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `https://${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co/rest/v1/rpc/set_runtime_feature_flag`,
    );
    assert.equal(calls[0].init.headers.apikey, SERVICE_KEY);
    assert.equal(calls[0].init.headers.authorization, `Bearer ${SERVICE_KEY}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      p_feature_name: 'notification_events',
      p_enabled: true,
      p_reason: REASON,
      p_idempotency_key: idempotencyKey,
    });
    assert.doesNotMatch(output, new RegExp(SERVICE_KEY, 'u'));
    assert.doesNotMatch(output, new RegExp(REASON, 'u'));
    assert.deepEqual(JSON.parse(output), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime flag CLI permits independent Telegram and ZH release gates in either direction', () => {
  for (const featureName of ['telegram_application_details', 'zh_username_password']) {
    for (const [enabled, expected] of [
      ['true', true],
      ['false', false],
    ]) {
      const parsed = parseRuntimeFlagArguments([
        ...mutationArguments('9b000000-0000-4000-8000-000000000012'),
        '--feature',
        featureName,
        '--enabled',
        enabled,
        '--secret-stdin',
      ]);
      assert.equal(parsed.featureName, featureName);
      assert.equal(parsed.enabled, expected);
    }
  }
});

test('Vault CLI derives the exact dispatcher URL and never emits either secret', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-vault-operator-test-'));
  try {
    const environmentFile = path.join(root, 'operator.env');
    await writeFile(
      environmentFile,
      `SUPABASE_SECRET_KEY=${SERVICE_KEY}\nTELEGRAM_DISPATCHER_SECRET=${DISPATCHER_SECRET}\n`,
      { mode: 0o600 },
    );
    const calls = [];
    let output = '';
    const idempotencyKey = '9b000000-0000-4000-8000-000000000002';
    const result = await configureVault(commonArguments(environmentFile, idempotencyKey), {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response({
          configured: true,
          vaultNames: ['notification_dispatch_url', 'notification_dispatch_secret'],
        });
      },
      writeOutput: (value) => {
        output += value;
      },
    });

    assert.equal(result.configured, true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(
      body.p_dispatch_url,
      `https://${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co/functions/v1/telegram-dispatcher`,
    );
    assert.equal(body.p_dispatch_secret, DISPATCHER_SECRET);
    assert.equal(body.p_reason, REASON);
    assert.equal(body.p_idempotency_key, idempotencyKey);
    assert.doesNotMatch(output, new RegExp(SERVICE_KEY, 'u'));
    assert.doesNotMatch(output, new RegExp(DISPATCHER_SECRET, 'u'));
    assert.doesNotMatch(output, new RegExp(REASON, 'u'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production mutation CLIs accept bounded non-TTY secrets without argv or disk persistence', async () => {
  const runtimeCalls = [];
  let runtimeOutput = '';
  await setRuntimeFlag(
    [
      ...mutationArguments('9b000000-0000-4000-8000-000000000007'),
      '--feature',
      'notification_events',
      '--enabled',
      'false',
      '--secret-stdin',
    ],
    {
      input: Readable.from([`${SERVICE_KEY}\r\n`]),
      fetchImpl: async (url, init) => {
        runtimeCalls.push({ url, init });
        return response({
          featureName: 'notification_events',
          enabled: false,
          changed: true,
          updatedAt: '2026-09-02T01:00:00.000Z',
        });
      },
      writeOutput: (value) => {
        runtimeOutput += value;
      },
    },
  );
  assert.equal(runtimeCalls[0].init.headers.apikey, SERVICE_KEY);
  assert.doesNotMatch(runtimeOutput, new RegExp(SERVICE_KEY, 'u'));

  const vaultCalls = [];
  let vaultOutput = '';
  await configureVault(
    [...mutationArguments('9b000000-0000-4000-8000-000000000008'), '--secret-stdin'],
    {
      input: Readable.from([
        `SUPABASE_SECRET_KEY=${SERVICE_KEY}\r\nTELEGRAM_DISPATCHER_SECRET=${DISPATCHER_SECRET}\r\n`,
      ]),
      fetchImpl: async (url, init) => {
        vaultCalls.push({ url, init });
        return response({
          configured: true,
          vaultNames: ['notification_dispatch_url', 'notification_dispatch_secret'],
        });
      },
      writeOutput: (value) => {
        vaultOutput += value;
      },
    },
  );
  const vaultBody = JSON.parse(vaultCalls[0].init.body);
  assert.equal(vaultCalls[0].init.headers.apikey, SERVICE_KEY);
  assert.equal(vaultBody.p_dispatch_secret, DISPATCHER_SECRET);
  assert.doesNotMatch(vaultOutput, new RegExp(SERVICE_KEY, 'u'));
  assert.doesNotMatch(vaultOutput, new RegExp(DISPATCHER_SECRET, 'u'));
});

test('stdin credential contracts reject mixed sources, TTY, order changes, and oversized input', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };
  await assert.rejects(
    setRuntimeFlag(
      [
        ...commonArguments(
          path.join(os.tmpdir(), 'operator-does-not-exist.env'),
          '9b000000-0000-4000-8000-000000000009',
        ),
        '--feature',
        'notification_events',
        '--enabled',
        'false',
        '--secret-stdin',
      ],
      { fetchImpl, input: Readable.from([SERVICE_KEY]) },
    ),
    /RUNTIME_FLAG_CREDENTIAL_SOURCE_INVALID/u,
  );

  const ttyInput = Readable.from([SERVICE_KEY]);
  ttyInput.isTTY = true;
  await assert.rejects(
    setRuntimeFlag(
      [
        ...mutationArguments('9b000000-0000-4000-8000-000000000010'),
        '--feature',
        'telegram_delivery',
        '--enabled',
        'false',
        '--secret-stdin',
      ],
      { fetchImpl, input: ttyInput },
    ),
    /OPERATOR_STDIN_TTY_REJECTED/u,
  );

  const vaultArguments = [
    ...mutationArguments('9b000000-0000-4000-8000-000000000011'),
    '--secret-stdin',
  ];
  await assert.rejects(
    configureVault(vaultArguments, {
      fetchImpl,
      input: Readable.from([
        `TELEGRAM_DISPATCHER_SECRET=${DISPATCHER_SECRET}\nSUPABASE_SECRET_KEY=${SERVICE_KEY}\n`,
      ]),
    }),
    /OPERATOR_STDIN_ASSIGNMENT_INVALID/u,
  );
  await assert.rejects(
    configureVault(vaultArguments, {
      fetchImpl,
      input: Readable.from([Buffer.alloc(8 * 1024 + 1, 0x61)]),
    }),
    /OPERATOR_STDIN_SECRET_TOO_LARGE/u,
  );
  assert.equal(calls, 0);
});

test('production operator CLIs reject target aliases and conflicting env assignments before fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };
  const missingEnvironment = path.join(os.tmpdir(), 'does-not-exist-operator.env');
  await assert.rejects(
    setRuntimeFlag(
      [
        '--expected-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--confirm-project-ref',
        'aaaaaaaaaaaaaaaaaaaa',
        '--feature',
        'notification_events',
        '--enabled',
        'false',
        '--reason',
        REASON,
        '--idempotency-key',
        '9b000000-0000-4000-8000-000000000003',
        '--env-file',
        missingEnvironment,
      ],
      { fetchImpl },
    ),
    /OPERATOR_PROJECT_REF_CONFIRMATION_MISMATCH/u,
  );
  await assert.rejects(
    configureVault(
      [
        '--expected-project-ref',
        'bbbbbbbbbbbbbbbbbbbb',
        '--confirm-project-ref',
        'bbbbbbbbbbbbbbbbbbbb',
        '--reason',
        REASON,
        '--idempotency-key',
        '9b000000-0000-4000-8000-000000000004',
        '--env-file',
        missingEnvironment,
      ],
      { fetchImpl },
    ),
    /OPERATOR_PROJECT_REF_NOT_CURRENT_PRODUCTION/u,
  );
  assert.equal(calls, 0);

  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-operator-env-test-'));
  try {
    const duplicateEnvironment = path.join(root, 'duplicate.env');
    await writeFile(
      duplicateEnvironment,
      `SUPABASE_SECRET_KEY=${SERVICE_KEY}\nSUPABASE_SECRET_KEY=${SERVICE_KEY}\n`,
    );
    await assert.rejects(
      setRuntimeFlag(
        [
          ...commonArguments(duplicateEnvironment, '9b000000-0000-4000-8000-000000000005'),
          '--feature',
          'telegram_delivery',
          '--enabled',
          'false',
        ],
        { fetchImpl },
      ),
      /OPERATOR_ENV_ASSIGNMENT_INVALID/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RPC error bodies are never reflected by production operator CLIs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-operator-error-test-'));
  try {
    const environmentFile = path.join(root, 'operator.env');
    await writeFile(environmentFile, `SUPABASE_SECRET_KEY=${SERVICE_KEY}\n`, { mode: 0o600 });
    let output = '';
    await assert.rejects(
      setRuntimeFlag(
        [
          ...commonArguments(environmentFile, '9b000000-0000-4000-8000-000000000006'),
          '--feature',
          'telegram_delivery',
          '--enabled',
          'false',
        ],
        {
          fetchImpl: async () => response({ leaked: SERVICE_KEY }, 500),
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      /OPERATOR_RPC_HTTP_500/u,
    );
    assert.equal(output, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
