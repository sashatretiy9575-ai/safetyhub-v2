#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OperatorToolError,
  confirmProductionRef,
  createBoundedFetch,
  parseStrictArguments,
  readEvidenceSalt,
  readOperatorConfig,
  readServiceCredential,
  runVisibleInventory,
  writeInventoryReport,
} from './storage-operator-tools.mjs';

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = parseStrictArguments(argv, ['--config', '--confirm-production-ref', '--output']);
  if (!args['--config'] || !args['--confirm-production-ref'] || !args['--output']) {
    throw new OperatorToolError('CLI_REQUIRED_ARGUMENT_MISSING');
  }
  const config = await readOperatorConfig(args['--config'], 'visible-inventory');
  confirmProductionRef(config, args['--confirm-production-ref']);
  const serviceCredential = readServiceCredential(config, environment);
  const evidenceSalt = readEvidenceSalt(config, environment);
  if (serviceCredential === evidenceSalt.toString('utf8')) {
    throw new OperatorToolError('OPERATOR_SECRETS_MUST_BE_DISTINCT');
  }
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(config.supabaseUrl, serviceCredential, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createBoundedFetch(config.requestTimeoutMs) },
  });
  const report = await runVisibleInventory({ client, config, evidenceSalt });
  await writeInventoryReport(args['--output'], report, realRepositoryRoot());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function realRepositoryRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main().catch((error) => {
    const code = error instanceof OperatorToolError ? error.code : 'UNEXPECTED_OPERATOR_FAILURE';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  });
}
