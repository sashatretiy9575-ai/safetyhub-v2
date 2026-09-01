import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  clearLinkedPostgresConnection,
  linkedPostgresEnvironment,
  loadPostgresSslRootCertificate,
  parseLinkedPostgresConnection,
} from './database-backup-security.mjs';
import {
  assertCurrentProductionProjectRef,
  assertLinkedProductionProjectRef,
} from './production-operator-safety.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const pgDumpPath = args.get('--pg-dump');
const outputDirectory = args.get('--output');
const expectedProjectRefArgument = args.get('--expected-project-ref');
const sslRootCertificatePath = args.get('--ssl-root-cert');
const sslRootCertificateSha256 = args.get('--ssl-root-cert-sha256');
if (!pgDumpPath || !outputDirectory || !expectedProjectRefArgument || !sslRootCertificatePath) {
  console.error(
    'Usage: --expected-project-ref <current-production-ref> --ssl-root-cert <absolute-Supabase-CA.pem> [--ssl-root-cert-sha256 <lowercase-sha256>] --pg-dump <pg_dump.exe> --output <new-empty-directory>',
  );
  process.exit(1);
}

const expectedProjectRef = assertCurrentProductionProjectRef(expectedProjectRefArgument);
await assertLinkedProductionProjectRef(expectedProjectRef);
const sslRootCertificate = await loadPostgresSslRootCertificate(sslRootCertificatePath, {
  expectedSha256: sslRootCertificateSha256,
});

const resolvedPgDump = path.resolve(pgDumpPath);
const resolvedOutput = path.resolve(outputDirectory);
const schemaPath = path.join(resolvedOutput, 'schema.sql');
const dataPath = path.join(resolvedOutput, 'data.sql');

function classifyPgDumpFailure(stderr) {
  const version = stderr.match(/server version:\s*([0-9.]+).*pg_dump version:\s*([0-9.]+)/isu);
  if (version) return `server/client version mismatch (${version[1]} / ${version[2]})`;
  if (/password authentication failed/iu.test(stderr))
    return 'temporary login authentication failed';
  const schemaPermission = stderr.match(/permission denied for schema\s+"?([a-z0-9_]+)"?/iu);
  if (schemaPermission) return `temporary login cannot read schema ${schemaPermission[1]}`;
  const relationPermission = stderr.match(
    /permission denied for (?:table|sequence|relation)\s+"?([a-z0-9_]+)"?/iu,
  );
  if (relationPermission) return `temporary login cannot read relation ${relationPermission[1]}`;
  if (/permission denied to set role/iu.test(stderr))
    return 'temporary login cannot assume dump role';
  if (/permission denied/iu.test(stderr)) return 'temporary login lacks required permissions';
  if (/connection.*timed out|timeout expired/iu.test(stderr))
    return 'database connection timed out';
  if (/could not translate host name/iu.test(stderr))
    return 'database hostname could not be resolved';
  if (/no matching schemas were found/iu.test(stderr))
    return 'one or more requested schemas are absent';
  return 'unclassified database export error';
}

function runPgDump(connection, dumpArgs) {
  const result = spawnSync(resolvedPgDump, dumpArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15 * 60 * 1000,
    env: linkedPostgresEnvironment(connection, sslRootCertificate),
  });
  if (result.error) throw new Error(`pg_dump could not start: ${result.error.message}`);
  if (result.status !== 0) {
    // pg_dump output can contain connection details on some versions. Never echo it.
    throw new Error(
      `pg_dump failed with exit code ${result.status ?? 'unknown'}: ${classifyPgDumpFailure(result.stderr)}.`,
    );
  }
}

await stat(resolvedPgDump);

const npxCli = path.join(
  path.dirname(process.execPath),
  'node_modules',
  'npm',
  'bin',
  'npx-cli.js',
);
await assertLinkedProductionProjectRef(expectedProjectRef);
const dryRun = spawnSync(
  process.execPath,
  [npxCli, 'supabase', 'db', 'dump', '--linked', '--dry-run'],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2 * 60 * 1000,
  },
);
if (dryRun.error || dryRun.status !== 0) {
  throw new Error('Supabase CLI could not create a temporary database login.');
}

const connection = parseLinkedPostgresConnection(`${dryRun.stdout}\n${dryRun.stderr}`, {
  allowUri: true,
});
if (!connection) throw new Error('Temporary database login was not present in CLI output.');
await assertLinkedProductionProjectRef(expectedProjectRef);
await mkdir(resolvedOutput, { recursive: false });

const commonArgs = [
  '--host',
  connection.PGHOST,
  '--port',
  connection.PGPORT,
  '--username',
  connection.PGUSER,
  '--dbname',
  connection.PGDATABASE,
  '--role=postgres',
  '--no-owner',
  '--no-privileges',
  '--quote-all-identifiers',
  '--encoding=UTF8',
];

try {
  runPgDump(connection, [
    ...commonArgs,
    '--schema-only',
    '--schema=public',
    '--schema=private',
    '--file',
    schemaPath,
  ]);
  runPgDump(connection, [
    ...commonArgs,
    '--data-only',
    '--schema=public',
    '--schema=private',
    '--schema=auth',
    '--schema=storage',
    '--file',
    dataPath,
  ]);

  const [schema, data] = await Promise.all([readFile(schemaPath), readFile(dataPath)]);
  if (schema.byteLength < 10_000 || data.byteLength < 1_000) {
    throw new Error('Database dump is unexpectedly small.');
  }
  console.log(
    JSON.stringify({
      ok: true,
      projectRef: expectedProjectRef,
      outputDirectory: resolvedOutput,
      schemaBytes: schema.byteLength,
      dataBytes: data.byteLength,
      schemas: ['public', 'private', 'auth', 'storage'],
      sslRootCertificate: {
        sha256: sslRootCertificate.sha256,
        fingerprint256: sslRootCertificate.fingerprint256,
      },
    }),
  );
} finally {
  clearLinkedPostgresConnection(connection);
}
