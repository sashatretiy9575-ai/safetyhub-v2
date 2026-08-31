import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const pgDumpPath = args.get('--pg-dump');
const outputDirectory = args.get('--output');
if (!pgDumpPath || !outputDirectory) {
  console.error('Usage: --pg-dump <pg_dump.exe> --output <new-empty-directory>');
  process.exit(1);
}

const resolvedPgDump = path.resolve(pgDumpPath);
const resolvedOutput = path.resolve(outputDirectory);
const schemaPath = path.join(resolvedOutput, 'schema.sql');
const dataPath = path.join(resolvedOutput, 'data.sql');

function decodeShellValue(rawValue) {
  const value = rawValue.trim().replace(/[;]$/u, '');
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readConnectionEnvironment(output) {
  const connection = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(
      /^(?:export\s+|set\s+)?(PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)=(.+)$/iu,
    );
    if (match) connection[match[1].toUpperCase()] = decodeShellValue(match[2]);
  }

  if (connection.PGHOST && connection.PGUSER && connection.PGPASSWORD) {
    connection.PGPORT ||= '5432';
    connection.PGDATABASE ||= 'postgres';
    return connection;
  }

  const uriMatch = output.match(
    /postgres(?:ql)?:\/\/([^:\s/'";]+):([^@\s/'";]+)@([^:\s/'";]+):(\d+)\/([^?\s'";]+)/iu,
  );
  if (!uriMatch) return null;
  return {
    PGUSER: decodeURIComponent(uriMatch[1]),
    PGPASSWORD: decodeURIComponent(uriMatch[2]),
    PGHOST: uriMatch[3],
    PGPORT: uriMatch[4],
    PGDATABASE: decodeURIComponent(uriMatch[5]),
  };
}

function classifyPgDumpFailure(stderr) {
  const version = stderr.match(/server version:\s*([0-9.]+).*pg_dump version:\s*([0-9.]+)/isu);
  if (version) return `server/client version mismatch (${version[1]} / ${version[2]})`;
  if (/password authentication failed/iu.test(stderr)) return 'temporary login authentication failed';
  const schemaPermission = stderr.match(/permission denied for schema\s+"?([a-z0-9_]+)"?/iu);
  if (schemaPermission) return `temporary login cannot read schema ${schemaPermission[1]}`;
  const relationPermission = stderr.match(
    /permission denied for (?:table|sequence|relation)\s+"?([a-z0-9_]+)"?/iu,
  );
  if (relationPermission) return `temporary login cannot read relation ${relationPermission[1]}`;
  if (/permission denied to set role/iu.test(stderr)) return 'temporary login cannot assume dump role';
  if (/permission denied/iu.test(stderr)) return 'temporary login lacks required permissions';
  if (/connection.*timed out|timeout expired/iu.test(stderr)) return 'database connection timed out';
  if (/could not translate host name/iu.test(stderr)) return 'database hostname could not be resolved';
  if (/no matching schemas were found/iu.test(stderr)) return 'one or more requested schemas are absent';
  return 'unclassified database export error';
}

function runPgDump(connection, dumpArgs) {
  const result = spawnSync(resolvedPgDump, dumpArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15 * 60 * 1000,
    env: {
      ...process.env,
      ...connection,
      PGSSLMODE: 'require',
    },
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

const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const dryRun = spawnSync(process.execPath, [npxCli, 'supabase', 'db', 'dump', '--linked', '--dry-run'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 2 * 60 * 1000,
});
if (dryRun.error || dryRun.status !== 0) {
  throw new Error('Supabase CLI could not create a temporary database login.');
}

const connection = readConnectionEnvironment(`${dryRun.stdout}\n${dryRun.stderr}`);
if (!connection) throw new Error('Temporary database login was not present in CLI output.');
if (!/^[-.a-z0-9]+[.]supabase[.](?:com|co)$/iu.test(connection.PGHOST)) {
  throw new Error('Refusing an unexpected database host.');
}
if (!/^cli_login_/u.test(connection.PGUSER)) {
  throw new Error('Refusing a non-ephemeral database user.');
}
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
      outputDirectory: resolvedOutput,
      schemaBytes: schema.byteLength,
      dataBytes: data.byteLength,
      schemas: ['public', 'private', 'auth', 'storage'],
    }),
  );
} finally {
  for (const name of Object.keys(connection)) connection[name] = '';
}
