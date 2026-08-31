import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const INCLUDED_SCHEMAS = ['public', 'private', 'auth', 'storage'];
const APPLICATION_SCHEMAS = ['public', 'private'];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outputArgument = argument('--output');
const postgresBinArgument = argument('--pg-bin') ?? process.env.SAFETYHUB_POSTGRES_BIN;
const recoveryKeyOutputArgument = argument('--recovery-key-output');
if (!outputArgument || !postgresBinArgument || !recoveryKeyOutputArgument) {
  console.error(
    'Usage: node scripts/backup-linked-database.mjs --output <new-directory> --pg-bin <PostgreSQL-17-bin> --recovery-key-output <new-file>',
  );
  process.exit(1);
}

const outputDirectory = path.resolve(outputArgument);
const recoveryKeyOutput = path.resolve(recoveryKeyOutputArgument);
const postgresBin = path.resolve(postgresBinArgument);
if (
  recoveryKeyOutput === outputDirectory ||
  recoveryKeyOutput.startsWith(`${outputDirectory}${path.sep}`)
) {
  throw new Error('The portable recovery key must be outside the encrypted backup directory.');
}
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const postgresTools = Object.fromEntries(
  ['pg_dump', 'pg_restore', 'psql', 'initdb', 'pg_ctl'].map((name) => [
    name,
    path.join(postgresBin, `${name}${executableSuffix}`),
  ]),
);
const temporaryRoot = path.resolve(os.tmpdir());
const workDirectory = path.join(temporaryRoot, `safetyhub-linked-backup-${randomUUID()}`);
const verificationDirectory = path.join(temporaryRoot, `safetyhub-backup-verify-${randomUUID()}`);
const rehearsalDirectory = path.join(temporaryRoot, `safetyhub-backup-rehearsal-${randomUUID()}`);
const schemaPath = path.join(workDirectory, 'schema.dump');
const dataPath = path.join(workDirectory, 'data.dump');

function isInsideTemporaryRoot(target) {
  const relative = path.relative(temporaryRoot, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

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
  if (!connection.PGHOST || !connection.PGUSER || !connection.PGPASSWORD) return null;
  connection.PGPORT ||= '5432';
  connection.PGDATABASE ||= 'postgres';
  return connection;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function runProcess(executable, args, options, label) {
  const exposeFailureOutput = options?.exposeFailureOutput === true;
  const processOptions = { ...options };
  delete processOptions.exposeFailureOutput;
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    ...processOptions,
  });
  if (result.error || result.status !== 0) {
    const safeFailureOutput = exposeFailureOutput
      ? `: ${String(result.stderr ?? result.stdout ?? '')
          .trim()
          .slice(0, 4_000)}`
      : '';
    throw new Error(
      result.error
        ? `${label} could not start`
        : `${label} failed with exit code ${result.status}${safeFailureOutput}`,
    );
  }
  return result.stdout ?? '';
}

function runNodeScript(script, args) {
  return runProcess(
    process.execPath,
    [path.resolve(script), ...args],
    {},
    path.basename(script),
  ).trim();
}

function postgresEnvironment(connection) {
  return {
    ...process.env,
    PGHOST: connection.PGHOST,
    PGPORT: connection.PGPORT,
    PGUSER: connection.PGUSER,
    PGPASSWORD: connection.PGPASSWORD,
    PGDATABASE: connection.PGDATABASE,
    PGSSLMODE: 'require',
  };
}

function archiveList(archivePath) {
  return runProcess(
    postgresTools.pg_restore,
    ['--list', archivePath],
    {},
    `pg_restore list for ${path.basename(archivePath)}`,
  );
}

function verifyArchiveLists(schemaList, dataList) {
  for (const required of ['SCHEMA - public', 'TABLE public', 'TRIGGER public', 'POLICY public']) {
    if (!schemaList.includes(required))
      throw new Error(`Schema archive is incomplete: ${required}.`);
  }
  for (const required of [
    'TABLE DATA public profiles',
    'TABLE DATA auth users',
    'TABLE DATA storage objects',
  ]) {
    if (!dataList.includes(required)) throw new Error(`Data archive is incomplete: ${required}.`);
  }
}

async function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function rehearseApplicationRestore(schemaDump, dataDump, sourceCounts) {
  await mkdir(rehearsalDirectory, { recursive: false });
  const cluster = path.join(rehearsalDirectory, 'cluster');
  const bootstrap = path.join(rehearsalDirectory, 'bootstrap.sql');
  const schemaRestoreList = path.join(rehearsalDirectory, 'schema-restore.list');
  const logPath = path.join(rehearsalDirectory, 'postgres.log');
  const port = await freeLocalPort();
  const localEnvironment = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'postgres',
    PGDATABASE: 'postgres',
  };
  let started = false;
  try {
    runProcess(
      postgresTools.initdb,
      [
        '--pgdata',
        cluster,
        '--username',
        'postgres',
        '--auth',
        'trust',
        '--encoding',
        'UTF8',
        '--no-locale',
      ],
      {},
      'initdb restore rehearsal',
    );
    runProcess(
      postgresTools.pg_ctl,
      [
        '--pgdata',
        cluster,
        '--options',
        `-h 127.0.0.1 -p ${port}`,
        '--wait',
        '--log',
        logPath,
        'start',
      ],
      { stdio: 'ignore' },
      'pg_ctl restore rehearsal start',
    );
    started = true;
    runProcess(
      postgresTools.psql,
      ['--set', 'ON_ERROR_STOP=1', '--command', 'create database safetyhub_restore'],
      { env: localEnvironment },
      'create restore rehearsal database',
    );
    const roleNames = [
      'anon',
      'authenticated',
      'service_role',
      'authenticator',
      'supabase_auth_admin',
      'dashboard_user',
    ];
    const roleSql = roleNames
      .map(
        (role) =>
          `if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${quoteIdentifier(role)} nologin; end if;`,
      )
      .join('\n');
    await writeFile(
      bootstrap,
      `drop schema public cascade;
create schema public;
create schema private;
create schema extensions;
-- The portable EDB PostgreSQL archive does not bundle contrib modules. These
-- signatures are sufficient to validate application DDL and data restoration;
-- the encrypted dump still retains the real extension-backed definitions and
-- indexes for restoration into Supabase/PostgreSQL with pgcrypto + pg_trgm.
create function extensions.digest(bytea, text) returns bytea
  language sql immutable parallel safe as $$ select decode(md5($1), 'hex') $$;
create function extensions.gen_random_bytes(integer) returns bytea
  language sql volatile parallel safe as $$ select decode(repeat('00', $1), 'hex') $$;
create function extensions.similarity(text, text) returns real
  language sql immutable parallel safe as $$ select 0::real $$;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $roles$
begin
${roleSql}
end;
$roles$;
`,
      'utf8',
    );
    const standaloneSchemaList = archiveList(schemaDump)
      .split(/\r?\n/u)
      .filter(
        (line) =>
          !line.includes(' SCHEMA - public ') &&
          !line.includes(' SCHEMA - private ') &&
          !line.includes('profiles_full_name_trgm_idx') &&
          !line.includes('profiles_organization_trgm_idx'),
      )
      .join('\n');
    await writeFile(schemaRestoreList, `${standaloneSchemaList}\n`, 'utf8');
    const restoreEnvironment = { ...localEnvironment, PGDATABASE: 'safetyhub_restore' };
    runProcess(
      postgresTools.psql,
      ['--set', 'ON_ERROR_STOP=1', '--file', bootstrap],
      { env: restoreEnvironment, exposeFailureOutput: true },
      'bootstrap restore rehearsal database',
    );
    runProcess(
      postgresTools.pg_restore,
      [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--use-list',
        schemaRestoreList,
        ...APPLICATION_SCHEMAS.flatMap((schema) => ['--schema', schema]),
        '--dbname',
        'safetyhub_restore',
        schemaDump,
      ],
      { env: restoreEnvironment, exposeFailureOutput: true },
      'restore rehearsal schema',
    );
    runProcess(
      postgresTools.pg_restore,
      [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--data-only',
        '--disable-triggers',
        ...APPLICATION_SCHEMAS.flatMap((schema) => ['--schema', schema]),
        '--dbname',
        'safetyhub_restore',
        dataDump,
      ],
      { env: restoreEnvironment, exposeFailureOutput: true },
      'restore rehearsal application data',
    );
    let verifiedTables = 0;
    for (const [qualifiedName, expected] of Object.entries(sourceCounts)) {
      const [schema, table] = qualifiedName.split('.');
      if (!APPLICATION_SCHEMAS.includes(schema)) continue;
      const output = runProcess(
        postgresTools.psql,
        [
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          `select count(*) from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
        ],
        { env: restoreEnvironment },
        `count restored ${qualifiedName}`,
      ).trim();
      if (Number(output) !== expected) {
        throw new Error(`Restore rehearsal count mismatch for ${qualifiedName}.`);
      }
      verifiedTables += 1;
    }
    if (verifiedTables === 0) throw new Error('Restore rehearsal verified no application tables.');
    return { status: 'passed', verifiedTables, postgresMajor: 17 };
  } finally {
    if (started) {
      runProcess(
        postgresTools.pg_ctl,
        ['--pgdata', cluster, '--mode', 'fast', '--wait', 'stop'],
        { stdio: 'ignore' },
        'pg_ctl restore rehearsal stop',
      );
    }
  }
}

for (const tool of Object.values(postgresTools)) await stat(tool);
const versionOutput = runProcess(postgresTools.pg_dump, ['--version'], {}, 'pg_dump version');
if (!/PostgreSQL\) 17[.]/u.test(versionOutput)) {
  throw new Error('A PostgreSQL 17 pg_dump toolchain is required.');
}
await stat(path.dirname(outputDirectory));
await mkdir(workDirectory, { recursive: false });

const supabaseCli = path.resolve('node_modules/supabase/dist/supabase.js');
const dryRun = spawnSync(process.execPath, [supabaseCli, 'db', 'dump', '--linked', '--dry-run'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 3 * 60 * 1000,
  maxBuffer: 8 * 1024 * 1024,
});
if (dryRun.error || dryRun.status !== 0) {
  throw new Error('Supabase CLI could not create a temporary linked database login.');
}

const connection = readConnectionEnvironment(`${dryRun.stdout}\n${dryRun.stderr}`);
if (!connection) throw new Error('Temporary linked database credentials were not available.');
if (!/^[-.a-z0-9]+[.]supabase[.](?:com|co)$/iu.test(connection.PGHOST)) {
  throw new Error('Refusing an unexpected database host.');
}
if (!/^cli_login_/u.test(connection.PGUSER)) {
  throw new Error('Refusing a non-ephemeral database user.');
}

const client = new Client({
  host: connection.PGHOST,
  port: Number(connection.PGPORT),
  user: connection.PGUSER,
  password: connection.PGPASSWORD,
  database: connection.PGDATABASE,
  ssl: { rejectUnauthorized: false },
  application_name: 'safetyhub-pgdump-backup',
  statement_timeout: 5 * 60 * 1000,
  query_timeout: 5 * 60 * 1000,
});

try {
  await client.connect();
  await client.query('begin isolation level repeatable read read only deferrable');
  await client.query('set local role postgres');
  const { rows: snapshotRows } = await client.query(
    "select pg_export_snapshot() as snapshot_id, current_database() as database, current_setting('server_version') as server_version, statement_timestamp() as snapshot_at",
  );
  const snapshotId = snapshotRows[0]?.snapshot_id;
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new Error('PostgreSQL did not export a consistent backup snapshot.');
  }
  const { rows: tableRows } = await client.query(
    `select table_schema, table_name
       from information_schema.tables
       where table_type = 'BASE TABLE' and table_schema = any($1::text[])
       order by table_schema, table_name`,
    [INCLUDED_SCHEMAS],
  );
  const counts = {};
  for (const table of tableRows) {
    const qualified = `${quoteIdentifier(table.table_schema)}.${quoteIdentifier(table.table_name)}`;
    const { rows } = await client.query(`select count(*)::integer as count from ${qualified}`);
    counts[`${table.table_schema}.${table.table_name}`] = Number(rows[0]?.count ?? 0);
  }
  const { rows: storageObjectRows } = await client.query(
    `select bucket_id, name,
            coalesce((metadata ->> 'size')::bigint, 0) as byte_size,
            coalesce(metadata ->> 'eTag', metadata ->> 'etag', '') as etag
       from storage.objects
       order by bucket_id, name`,
  );

  const commonDumpArguments = [
    '--host',
    connection.PGHOST,
    '--port',
    connection.PGPORT,
    '--username',
    connection.PGUSER,
    '--dbname',
    connection.PGDATABASE,
    '--role=postgres',
    '--snapshot',
    snapshotId,
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--quote-all-identifiers',
    '--encoding=UTF8',
    ...INCLUDED_SCHEMAS.flatMap((schema) => ['--schema', schema]),
  ];
  const dumpEnvironment = postgresEnvironment(connection);
  runProcess(
    postgresTools.pg_dump,
    [...commonDumpArguments, '--schema-only', '--file', schemaPath],
    { env: dumpEnvironment },
    'pg_dump schema backup',
  );
  runProcess(
    postgresTools.pg_dump,
    [...commonDumpArguments, '--data-only', '--file', dataPath],
    { env: dumpEnvironment },
    'pg_dump data backup',
  );
  await client.query('commit');

  const [schemaBytes, dataBytes] = await Promise.all([readFile(schemaPath), readFile(dataPath)]);
  if (schemaBytes.byteLength < 10_000 || dataBytes.byteLength < 1_000) {
    throw new Error('PostgreSQL dump archives are unexpectedly small.');
  }
  verifyArchiveLists(archiveList(schemaPath), archiveList(dataPath));

  runNodeScript('scripts/create-database-backup.mjs', [
    '--schema',
    schemaPath,
    '--data',
    dataPath,
    '--output',
    outputDirectory,
    '--recovery-key-output',
    recoveryKeyOutput,
  ]);
  runNodeScript('scripts/restore-database-backup.mjs', [
    '--backup',
    outputDirectory,
    '--output',
    verificationDirectory,
    '--recovery-key-file',
    recoveryKeyOutput,
  ]);

  const restoredSchemaPath = path.join(verificationDirectory, 'schema.dump');
  const restoredDataPath = path.join(verificationDirectory, 'data.dump');
  const [verifiedSchema, verifiedData, receipt] = await Promise.all([
    readFile(restoredSchemaPath),
    readFile(restoredDataPath),
    readFile(path.join(outputDirectory, 'receipt.json'), 'utf8').then(JSON.parse),
  ]);
  verifyArchiveLists(archiveList(restoredSchemaPath), archiveList(restoredDataPath));
  if (
    verifiedSchema.byteLength < 10_000 ||
    verifiedData.byteLength < 1_000 ||
    !Array.isArray(receipt.artifacts) ||
    receipt.artifacts.length !== 2
  ) {
    throw new Error('Encrypted pg_dump verification did not meet the safety gate.');
  }

  const restoreRehearsal = await rehearseApplicationRestore(
    restoredSchemaPath,
    restoredDataPath,
    counts,
  );
  const storageBuckets = {};
  for (const object of storageObjectRows) {
    const bucketId = String(object.bucket_id ?? 'unknown');
    const current = storageBuckets[bucketId] ?? { objects: 0, bytes: 0 };
    current.objects += 1;
    current.bytes += Number(object.byte_size ?? 0);
    storageBuckets[bucketId] = current;
  }
  const storageObjectSetSha256 = createHash('sha256')
    .update(
      JSON.stringify(
        storageObjectRows.map((object) => [
          object.bucket_id,
          object.name,
          Number(object.byte_size ?? 0),
          object.etag,
        ]),
      ),
    )
    .digest('hex');
  const summary = {
    ok: true,
    kind: 'safetyhub-encrypted-pgdump-backup-v2',
    outputDirectory,
    createdAt: new Date().toISOString(),
    snapshotAt: snapshotRows[0]?.snapshot_at,
    serverVersion: snapshotRows[0]?.server_version,
    pgDumpVersion: versionOutput.trim(),
    includedSchemas: INCLUDED_SCHEMAS,
    tables: tableRows.length,
    counts,
    storageManifest: {
      objects: storageObjectRows.length,
      buckets: storageBuckets,
      objectSetSha256: storageObjectSetSha256,
      rawObjectMetadata: 'encrypted:data.dump',
    },
    encryptedReceiptSha256: createHash('sha256')
      .update(await readFile(path.join(outputDirectory, 'receipt.json')))
      .digest('hex'),
    archiveListVerification: 'passed',
    portableRecoveryVerification: 'passed',
    restoreRehearsal,
  };
  await writeFile(
    path.join(outputDirectory, 'verification.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  try {
    await client.query('rollback');
  } catch {
    // The connection may already be closed. The original error is authoritative.
  }
  throw new Error(
    error instanceof Error
      ? `Linked pg_dump backup failed: ${error.message.replaceAll(connection.PGPASSWORD, '[redacted]')}`
      : 'Linked pg_dump backup failed.',
  );
} finally {
  connection.PGPASSWORD = '';
  await client.end().catch(() => undefined);
  for (const target of [workDirectory, verificationDirectory, rehearsalDirectory]) {
    if (isInsideTemporaryRoot(target)) {
      await rm(target, { recursive: true, force: true });
    }
  }
}
