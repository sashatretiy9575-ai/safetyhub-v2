import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  drainUrlForOrigin,
  main as configureDrainVault,
  parseArguments,
  VAULT_NAMES,
} from '../../scripts/auth/configure-auth-email-drain-vault.mjs';
import { CURRENT_PRODUCTION_PROJECT_REF } from '../../scripts/ops/production-operator-safety.mjs';

const SERVICE_KEY = `sb_secret_${'s'.repeat(48)}`;
const DRAIN_SECRET = `drain-${'d'.repeat(40)}`;

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the drain URL is derived from a bare HTTPS origin only', () => {
  assert.equal(drainUrlForOrigin('https://safetyhub.kz'), 'https://safetyhub.kz/api/auth/send-email/drain');
  assert.equal(drainUrlForOrigin('https://safetyhub.kz/'), 'https://safetyhub.kz/api/auth/send-email/drain');
  for (const origin of [
    'http://safetyhub.kz',
    'https://safetyhub.kz/admin',
    'https://safetyhub.kz?x=1',
    'https://user:pw@safetyhub.kz',
    'not a url',
  ]) {
    assert.throws(() => drainUrlForOrigin(origin), /VAULT_CONFIG_SITE_ORIGIN_INVALID/u, origin);
  }
});

test('the CLI binds the current production project, stores the pair through the service RPC and prints no secret', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-drain-vault-test-'));
  try {
    const environmentFile = path.join(root, 'operator.env');
    await writeFile(
      environmentFile,
      `SUPABASE_SECRET_KEY=${SERVICE_KEY}\nAUTH_EMAIL_DRAIN_SECRET=${DRAIN_SECRET}\n`,
      { mode: 0o600 },
    );
    const calls = [];
    let output = '';
    const result = await configureDrainVault(
      [
        '--expected-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--confirm-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--site-origin',
        'https://safetyhub.kz',
        '--env-file',
        environmentFile,
      ],
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return response({ configured: true, configuredAt: '2026-09-12T18:00:00Z' });
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `https://${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co/rest/v1/rpc/configure_auth_email_drain_vault`,
    );
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      p_drain_url: 'https://safetyhub.kz/api/auth/send-email/drain',
      p_drain_secret: DRAIN_SECRET,
    });
    assert.deepEqual(result, {
      ok: true,
      projectRef: CURRENT_PRODUCTION_PROJECT_REF,
      configured: true,
      drainUrl: 'https://safetyhub.kz/api/auth/send-email/drain',
      vaultNames: [...VAULT_NAMES],
    });
    assert.equal(output.includes(DRAIN_SECRET), false);
    assert.equal(output.includes(SERVICE_KEY), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('argument parsing refuses a mismatched confirmation, a placeholder secret source and unknown flags', () => {
  assert.throws(
    () =>
      parseArguments([
        '--expected-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--confirm-project-ref',
        'somethingelse0000000',
        '--site-origin',
        'https://safetyhub.kz',
        '--secret-stdin',
      ]),
    /OPERATOR_PROJECT_REF/u,
  );
  assert.throws(
    () =>
      parseArguments([
        '--expected-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--confirm-project-ref',
        CURRENT_PRODUCTION_PROJECT_REF,
        '--site-origin',
        'https://safetyhub.kz',
        '--env-file',
        'relative.env',
      ]),
    /VAULT_CONFIG_ENV_FILE_PATH_INVALID/u,
  );
  assert.throws(
    () => parseArguments(['--unknown', 'x']),
    /VAULT_CONFIG_CLI_UNKNOWN_ARGUMENT/u,
  );
});
