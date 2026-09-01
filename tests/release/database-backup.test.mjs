import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCACertificates } from 'node:tls';
import {
  assertPhysicalPathRelationship,
  clearLinkedPostgresConnection,
  linkedPostgresClientOptions,
  linkedPostgresEnvironment,
  loadPostgresSslRootCertificate,
  parseLinkedPostgresConnection,
  validateDatabaseBackupReceipt,
} from '../../scripts/database-backup-security.mjs';
import {
  CURRENT_PRODUCTION_PROJECT_REF,
  assertLinkedProductionProjectRef,
} from '../../scripts/production-operator-safety.mjs';

const ARTIFACT_OVERHEAD = Buffer.byteLength('SAFETYHUB-DB-BACKUP-V1\0') + 12 + 16;

function backupReceipt(
  artifactNames = ['tenant-schema.sql.aes256gcm', 'tenant-data.dump.aes256gcm'],
) {
  return {
    kind: 'safetyhub-database-backup-v1',
    createdAt: '2026-09-01T00:00:00.000Z',
    cipher: 'aes-256-gcm',
    keyProtection: ['windows-dpapi-current-user', 'portable-recovery-key-aes-256-gcm'],
    artifacts: artifactNames.map((name, index) => ({
      name,
      plaintextBytes: 128 + index,
      plaintextSha256: String(index).repeat(64),
      encryptedBytes: 128 + index + ARTIFACT_OVERHEAD,
      encryptedSha256: String(index + 2).repeat(64),
    })),
    portableRecovery: {
      algorithm: 'aes-256-gcm',
      wrappedKeyFile: 'database-backup.key.recovery.aes256gcm',
      encryptedSha256: 'f'.repeat(64),
      recoveryKeyFormat: 'SAFETYHUB-RECOVERY-KEY-V1',
    },
  };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

test('database backup encrypts, verifies, and restores exact dump bytes', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows DPAPI contract is exercised on the release workstation.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-database-backup-test-'));
  try {
    const schema = path.join(root, 'tenant-schema.sql');
    const data = path.join(root, 'tenant-data.dump');
    const backup = path.join(root, 'encrypted');
    const recoveryKey = path.join(root, 'portable-recovery-key.txt');
    const restoredWithDpapi = path.join(root, 'restored-dpapi');
    const restoredWithRecoveryKey = path.join(root, 'restored-portable');
    const schemaBytes = Buffer.from(`create schema public;\n${'-'.repeat(256)}\n`);
    const dataBytes = Buffer.from(
      `copy public.example from stdin;\n${'1\tSafetyHub\n'.repeat(32)}\\.\n`,
    );
    await writeFile(schema, schemaBytes);
    await writeFile(data, dataBytes);

    const created = spawnSync(
      process.execPath,
      [
        'scripts/create-database-backup.mjs',
        '--schema',
        schema,
        '--data',
        data,
        '--output',
        backup,
        '--recovery-key-output',
        recoveryKey,
      ],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.equal(created.status, 0, created.stderr);
    await assert.rejects(readFile(schema));
    await assert.rejects(readFile(data));

    const recovered = spawnSync(
      process.execPath,
      ['scripts/restore-database-backup.mjs', '--backup', backup, '--output', restoredWithDpapi],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(
      await readFile(path.join(restoredWithDpapi, 'tenant-schema.sql')),
      schemaBytes,
    );
    assert.deepEqual(await readFile(path.join(restoredWithDpapi, 'tenant-data.dump')), dataBytes);

    const recoveredPortably = spawnSync(
      process.execPath,
      [
        'scripts/restore-database-backup.mjs',
        '--backup',
        backup,
        '--output',
        restoredWithRecoveryKey,
        '--recovery-key-file',
        recoveryKey,
      ],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.equal(recoveredPortably.status, 0, recoveredPortably.stderr);
    assert.deepEqual(
      await readFile(path.join(restoredWithRecoveryKey, 'tenant-schema.sql')),
      schemaBytes,
    );
    assert.deepEqual(
      await readFile(path.join(restoredWithRecoveryKey, 'tenant-data.dump')),
      dataBytes,
    );
    const receipt = JSON.parse(await readFile(path.join(backup, 'receipt.json'), 'utf8'));
    assert.equal(receipt.portableRecovery.algorithm, 'aes-256-gcm');
    assert.match(await readFile(recoveryKey, 'utf8'), /^SAFETYHUB-RECOVERY-KEY-V1:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linked backup uses a read-only snapshot and never persists temporary credentials', async () => {
  const [source, contentSync, legacyDump, securityHelper] = await Promise.all([
    readFile('scripts/backup-linked-database.mjs', 'utf8'),
    readFile('scripts/content-sync-linked.mjs', 'utf8'),
    readFile('scripts/dump-linked-database.mjs', 'utf8'),
    readFile('scripts/database-backup-security.mjs', 'utf8'),
  ]);
  assert.match(source, /repeatable read read only deferrable/u);
  assert.match(source, /pg_export_snapshot/u);
  assert.match(source, /--format=custom/u);
  assert.match(source, /rehearseApplicationRestore/u);
  assert.match(source, /--disable-triggers/u);
  assert.match(source, /set local role postgres/u);
  assert.match(source, /\['public', 'private', 'auth', 'storage'\]/u);
  assert.match(source, /clearLinkedPostgresConnection\(connection\)/u);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*PGPASSWORD/u);
  assert.match(source, /restore-database-backup\.mjs/u);
  assert.match(source, /archiveListVerification: 'passed'/u);
  assert.match(source, /portableRecoveryVerification: 'passed'/u);
  assert.match(source, /--recovery-key-output/u);
  assert.match(source, /--recovery-key-file/u);
  assert.match(source, /--expected-project-ref/u);
  assert.match(source, /assertLinkedProductionProjectRef\(expectedProjectRef\)/u);
  assert.match(source, /projectRef: expectedProjectRef/u);
  assert.match(source, /storageObjectSetSha256/u);
  assert.match(source, /rawObjectMetadata: 'encrypted:data\.dump'/u);
  for (const linkedScript of [source, contentSync, legacyDump]) {
    assert.match(linkedScript, /database-backup-security[.]mjs/u);
    assert.doesNotMatch(linkedScript, /rejectUnauthorized:\s*false/u);
    assert.doesNotMatch(linkedScript, /PGSSLMODE:\s*'require'/u);
  }
  assert.match(securityHelper, /new X509Certificate/u);
  assert.match(securityHelper, /certificate\.ca !== true/u);
  assert.match(securityHelper, /expectedSha256/u);
  assert.match(securityHelper, /checkServerIdentity/u);
  assert.match(securityHelper, /rejectUnauthorized:\s*true/u);
  assert.match(securityHelper, /PGSSLMODE:\s*'verify-full'/u);
  assert.match(securityHelper, /PGSSLROOTCERT: certificate\.physicalPath/u);
});

test('linked database backup binds the explicit current production ref to the local link', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-linked-ref-test-'));
  try {
    const linkedRefFile = path.join(root, 'project-ref');
    await writeFile(linkedRefFile, `${CURRENT_PRODUCTION_PROJECT_REF}\n`);
    assert.equal(
      await assertLinkedProductionProjectRef(CURRENT_PRODUCTION_PROJECT_REF, {
        projectRefFile: linkedRefFile,
      }),
      CURRENT_PRODUCTION_PROJECT_REF,
    );

    await writeFile(linkedRefFile, 'aaaaaaaaaaaaaaaaaaaa\n');
    await assert.rejects(
      assertLinkedProductionProjectRef(CURRENT_PRODUCTION_PROJECT_REF, {
        projectRefFile: linkedRefFile,
      }),
      /OPERATOR_LINKED_PROJECT_REF_MISMATCH/u,
    );
    await assert.rejects(
      assertLinkedProductionProjectRef('bbbbbbbbbbbbbbbbbbbb', {
        projectRefFile: linkedRefFile,
      }),
      /OPERATOR_PROJECT_REF_NOT_CURRENT_PRODUCTION/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linked PostgreSQL helper requires an explicit validated CA and ignores inherited libpq weakening', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-postgres-ca-test-'));
  const certificatePath = path.join(root, 'root-ca.pem');
  await writeFile(certificatePath, getCACertificates('bundled')[0]);
  const sslRootCertificate = await loadPostgresSslRootCertificate(certificatePath);
  const connection = parseLinkedPostgresConnection(
    [
      'PGHOST=aws-0-eu-central-1.pooler.supabase.com',
      'PGPORT=6543',
      'PGUSER=cli_login_release',
      'PGPASSWORD=temporary-secret',
      'PGDATABASE=postgres',
    ].join('\n'),
  );
  const clientOptions = linkedPostgresClientOptions(connection, {
    application_name: 'safetyhub-test',
    ssl: { rejectUnauthorized: false },
    sslRootCertificate,
  });
  assert.equal(clientOptions.host, connection.PGHOST);
  assert.equal(clientOptions.ssl.rejectUnauthorized, true);
  assert.equal(clientOptions.ssl.servername, connection.PGHOST);
  assert.equal(typeof clientOptions.ssl.checkServerIdentity, 'function');
  assert.match(clientOptions.ssl.ca, /BEGIN CERTIFICATE/u);

  const environment = linkedPostgresEnvironment(connection, sslRootCertificate, {
    Path: 'C:\\Windows',
    PGSSLMODE: 'disable',
    pgsslrootcert: 'attacker.pem',
    PGSERVICE: 'untrusted-service',
    PGPASSFILE: 'untrusted-passfile',
  });
  assert.equal(environment.Path, 'C:\\Windows');
  assert.equal(environment.PGSSLMODE, 'verify-full');
  assert.equal(environment.PGSSLROOTCERT, sslRootCertificate.physicalPath);
  assert.equal(environment.PGSERVICE, undefined);
  assert.equal(environment.PGPASSFILE, undefined);
  assert.equal(environment.pgsslrootcert, undefined);

  clearLinkedPostgresConnection(connection);
  assert.deepEqual(connection, {
    PGHOST: '',
    PGPORT: '',
    PGUSER: '',
    PGPASSWORD: '',
    PGDATABASE: '',
  });
  await rm(root, { recursive: true, force: true });
});

test('PostgreSQL CA loader enforces regular CA PEM, validity, and optional SHA-256 pin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-postgres-ca-pin-test-'));
  try {
    const certificatePath = path.join(root, 'root-ca.pem');
    await writeFile(certificatePath, getCACertificates('bundled')[0]);
    const loaded = await loadPostgresSslRootCertificate(certificatePath);
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/u);
    assert.match(loaded.fingerprint256, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
    assert.equal(
      (await loadPostgresSslRootCertificate(certificatePath, { expectedSha256: loaded.sha256 }))
        .sha256,
      loaded.sha256,
    );
    await assert.rejects(
      loadPostgresSslRootCertificate(certificatePath, { expectedSha256: '0'.repeat(64) }),
      /SHA-256 pin mismatch/u,
    );
    await assert.rejects(
      loadPostgresSslRootCertificate(certificatePath, {
        now: () => new Date('2100-01-01T00:00:00.000Z'),
      }),
      /outside its validity period/u,
    );
    await assert.rejects(
      loadPostgresSslRootCertificate(path.join(root, 'missing.pem')),
      /certificate is unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linked PostgreSQL helper validates host, user, and URI credentials without disclosing secrets', () => {
  const fromUri = parseLinkedPostgresConnection(
    'postgresql://cli_login_release:secret%3Avalue@db.project.supabase.co:5432/postgres',
    { allowUri: true },
  );
  assert.equal(fromUri.PGPASSWORD, 'secret:value');
  assert.equal(fromUri.PGHOST, 'db.project.supabase.co');
  assert.throws(
    () =>
      parseLinkedPostgresConnection(
        'PGHOST=attacker.example\nPGUSER=cli_login_release\nPGPASSWORD=do-not-echo',
      ),
    (error) => {
      assert.match(error.message, /credentials were invalid/u);
      assert.doesNotMatch(error.message, /do-not-echo/u);
      return true;
    },
  );
  assert.throws(() =>
    parseLinkedPostgresConnection(
      'PGHOST=db.project.supabase.co\nPGUSER=postgres\nPGPASSWORD=do-not-echo',
    ),
  );
  assert.throws(() =>
    parseLinkedPostgresConnection(
      'PGHOST=db.project.supabase.co\nPGPORT=70000\nPGUSER=cli_login_release\nPGPASSWORD=x',
    ),
  );
});

test('V1 receipt validation preserves safe generic SQL and dump basenames', () => {
  const receipt = validateDatabaseBackupReceipt(
    backupReceipt(['north-region-schema.sql.aes256gcm', '2026-09-data.dump.aes256gcm']),
  );
  assert.deepEqual(
    receipt.artifacts.map((artifact) => artifact.outputName),
    ['north-region-schema.sql', '2026-09-data.dump'],
  );
});

test('V1 receipt validation rejects path syntax and Windows filename aliases', () => {
  const unsafeNames = [
    '.',
    '..',
    '../outside.sql.aes256gcm',
    '..\\outside.dump.aes256gcm',
    'nested/artifact.sql.aes256gcm',
    'nested\\artifact.dump.aes256gcm',
    '/absolute/artifact.sql.aes256gcm',
    'C:\\absolute\\artifact.dump.aes256gcm',
    '\\\\server\\share\\artifact.sql.aes256gcm',
    '\\\\?\\C:\\artifact.dump.aes256gcm',
    '\\\\.\\NUL\\artifact.sql.aes256gcm',
    'artifact:stream.sql.aes256gcm',
    'artifact\u0001.sql.aes256gcm',
    'CON.sql.aes256gcm',
    'CON .sql.aes256gcm',
    'com1.dump.aes256gcm',
    'artifact.sql.aes256gcm.',
    'artifact.dump.aes256gcm ',
  ];
  for (const unsafeName of unsafeNames) {
    const receipt = backupReceipt();
    receipt.artifacts[0].name = unsafeName;
    assert.throws(
      () => validateDatabaseBackupReceipt(receipt),
      /Database backup receipt is invalid/u,
      unsafeName,
    );
  }
});

test('V1 receipt validation rejects collisions, malformed fields, and unsafe wrapped-key names', () => {
  assert.throws(() =>
    validateDatabaseBackupReceipt(backupReceipt(['Region.sql.aes256gcm', 'region.SQL.aes256gcm'])),
  );

  const mutations = [
    (receipt) => {
      receipt.artifacts[0].plaintextBytes = 128.5;
    },
    (receipt) => {
      receipt.artifacts[0].encryptedBytes = -1;
    },
    (receipt) => {
      receipt.artifacts[0].plaintextBytes = -0;
    },
    (receipt) => {
      receipt.artifacts[0].plaintextSha256 = 'a'.repeat(63);
    },
    (receipt) => {
      receipt.artifacts[0].encryptedSha256 = 'A'.repeat(64);
    },
    (receipt) => {
      receipt.artifacts[0].unexpected = true;
    },
    (receipt) => {
      receipt.createdAt = 'not-a-timestamp';
    },
    (receipt) => {
      receipt.cipher = 'none';
    },
    (receipt) => {
      receipt.keyProtection.reverse();
    },
    (receipt) => {
      receipt.portableRecovery.wrappedKeyFile = '../wrapped-key';
    },
    (receipt) => {
      receipt.portableRecovery.encryptedSha256 = '0'.repeat(65);
    },
    (receipt) => {
      receipt.unknown = 'field';
    },
  ];
  for (const mutate of mutations) {
    const receipt = backupReceipt();
    mutate(receipt);
    assert.throws(() => validateDatabaseBackupReceipt(receipt), /receipt is invalid/u);
  }

  const oversizedArtifactList = backupReceipt();
  oversizedArtifactList.artifacts = Array.from({ length: 33 }, (_, index) => ({
    ...oversizedArtifactList.artifacts[0],
    name: `artifact-${index}.dump.aes256gcm`,
  }));
  assert.throws(() => validateDatabaseBackupReceipt(oversizedArtifactList), /receipt is invalid/u);
});

test('restore rejects an unsafe receipt before creating output and does not echo its name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-unsafe-receipt-test-'));
  try {
    const backup = path.join(root, 'backup');
    const output = path.join(root, 'plaintext-output');
    await mkdir(backup);
    const receipt = backupReceipt();
    const unsafeName = '..\\do-not-echo.dump.aes256gcm';
    receipt.artifacts[0].name = unsafeName;
    await writeFile(path.join(backup, 'receipt.json'), JSON.stringify(receipt));
    const restored = spawnSync(
      process.execPath,
      ['scripts/restore-database-backup.mjs', '--backup', backup, '--output', output],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.notEqual(restored.status, 0);
    assert.match(restored.stderr, /Database backup receipt is invalid/u);
    assert.doesNotMatch(restored.stderr, /do-not-echo/u);
    assert.equal(await pathExists(output), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restore bounds receipt input and keeps plaintext output outside the encrypted backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-bounded-receipt-test-'));
  try {
    const oversizedBackup = path.join(root, 'oversized-backup');
    const oversizedOutput = path.join(root, 'oversized-output');
    await mkdir(oversizedBackup);
    await writeFile(path.join(oversizedBackup, 'receipt.json'), Buffer.alloc(64 * 1024 + 1, 0x20));
    const oversizedResult = spawnSync(
      process.execPath,
      [
        'scripts/restore-database-backup.mjs',
        '--backup',
        oversizedBackup,
        '--output',
        oversizedOutput,
      ],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.notEqual(oversizedResult.status, 0);
    assert.match(oversizedResult.stderr, /Database backup receipt is invalid/u);
    assert.equal(await pathExists(oversizedOutput), false);

    const nestedBackup = path.join(root, 'nested-backup');
    const nestedOutput = path.join(nestedBackup, 'plaintext');
    await mkdir(nestedBackup);
    await writeFile(path.join(nestedBackup, 'receipt.json'), JSON.stringify(backupReceipt()));
    const nestedResult = spawnSync(
      process.execPath,
      ['scripts/restore-database-backup.mjs', '--backup', nestedBackup, '--output', nestedOutput],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.notEqual(nestedResult.status, 0);
    assert.match(nestedResult.stderr, /must be outside the encrypted backup directory/u);
    assert.equal(await pathExists(nestedOutput), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical path guard checks absent targets and rejects nested output paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-physical-path-test-'));
  try {
    const output = path.join(root, 'encrypted');
    await assert.rejects(() =>
      assertPhysicalPathRelationship({
        directoryPath: output,
        candidatePath: path.join(output, 'portable-key.txt'),
        relationship: 'outside',
        directoryExpectation: 'absent',
        candidateExpectation: 'absent',
      }),
    );
    const existingKey = path.join(root, 'existing-key.txt');
    await writeFile(existingKey, 'existing');
    await assert.rejects(
      () =>
        assertPhysicalPathRelationship({
          directoryPath: output,
          candidatePath: existingKey,
          relationship: 'outside',
          directoryExpectation: 'absent',
          candidateExpectation: 'absent',
        }),
      /must not already exist/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical path guard treats Windows case aliases as the same output path', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows case-folding is exercised on the release workstation.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-path-case-test-'));
  try {
    await assert.rejects(() =>
      assertPhysicalPathRelationship({
        directoryPath: path.join(root, 'Encrypted-Output'),
        candidatePath: path.join(root, 'eNCRYPTED-oUTPUT', 'portable-key.txt'),
        relationship: 'outside',
        directoryExpectation: 'absent',
        candidateExpectation: 'absent',
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backup creation rejects a Windows case-alias recovery path before output creation', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows case-folding is exercised on the release workstation.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-create-case-test-'));
  try {
    const schema = path.join(root, 'schema.sql');
    const data = path.join(root, 'data.dump');
    const output = path.join(root, 'Encrypted-Output');
    const recoveryKey = path.join(root, 'eNCRYPTED-oUTPUT', 'portable-key.txt');
    await writeFile(schema, Buffer.alloc(128, 0x41));
    await writeFile(data, Buffer.alloc(128, 0x42));
    const created = spawnSync(
      process.execPath,
      [
        'scripts/create-database-backup.mjs',
        '--schema',
        schema,
        '--data',
        data,
        '--output',
        output,
        '--recovery-key-output',
        recoveryKey,
      ],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    assert.notEqual(created.status, 0);
    assert.match(created.stderr, /outside the encrypted backup directory/u);
    assert.equal(await pathExists(output), false);
    assert.equal(await pathExists(schema), true);
    assert.equal(await pathExists(data), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical path guard resolves a junction before containment checks when available', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-path-junction-test-'));
  try {
    const physicalParent = path.join(root, 'physical-parent');
    const aliasParent = path.join(root, 'junction-parent');
    await mkdir(physicalParent);
    try {
      await symlink(physicalParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)
      ) {
        context.skip('This workstation does not permit creating a test junction.');
        return;
      }
      throw error;
    }
    await assert.rejects(() =>
      assertPhysicalPathRelationship({
        directoryPath: path.join(physicalParent, 'encrypted'),
        candidatePath: path.join(aliasParent, 'encrypted', 'portable-key.txt'),
        relationship: 'outside',
        directoryExpectation: 'absent',
        candidateExpectation: 'absent',
      }),
    );
    await assert.rejects(
      () =>
        assertPhysicalPathRelationship({
          directoryPath: root,
          candidatePath: aliasParent,
          relationship: 'inside',
          directoryExpectation: 'directory',
          candidateExpectation: 'directory',
        }),
      /symbolic link or junction/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private avatar backup has a portable recovery path independent of DPAPI', async () => {
  const [runner, verifier] = await Promise.all([
    readFile('scripts/run-private-avatar-backup.mjs', 'utf8'),
    readFile('scripts/verify-private-avatar-backup.mjs', 'utf8'),
  ]);
  assert.match(runner, /--recovery-key-output/u);
  assert.match(runner, /SAFETYHUB-AVATAR-RECOVERY-KEY-V1/u);
  assert.match(runner, /portable-recovery-key/u);
  assert.match(verifier, /--recovery-key-file/u);
  assert.match(verifier, /SAFETYHUB-AVATAR-RECOVERY-KEY-V1/u);
  assert.match(verifier, /keyProtection = 'portable-recovery-key'/u);
});

test('generic Storage byte backup requires the full allowlist and a portable recovery verification path', async () => {
  const [runner, verifier, core] = await Promise.all([
    readFile('scripts/backup-linked-storage.mjs', 'utf8'),
    readFile('scripts/verify-linked-storage-backup.mjs', 'utf8'),
    readFile('scripts/storage-byte-backup-tools.mjs', 'utf8'),
  ]);
  assert.match(runner, /--expected-project-ref/u);
  assert.match(runner, /--allow-bucket/u);
  assert.match(runner, /--recovery-key-output/u);
  assert.match(runner, /SAFETYHUB-STORAGE-RECOVERY-KEY-V1/u);
  assert.match(runner, /assertRecoveryKeyOutsideOutput/u);
  assert.match(verifier, /--recovery-key-file/u);
  assert.match(verifier, /SAFETYHUB-STORAGE-RECOVERY-KEY-V1/u);
  assert.match(verifier, /verifyStorageByteBackup/u);
  assert.match(core, /SAFETYHUB_STORAGE_BUCKET_ALLOWLIST/u);
  assert.match(core, /STORAGE_BACKUP_BUCKET_SET_INCOMPLETE/u);
  assert.match(core, /downloadedEveryListedVisibleObject:\s*true/u);
  assert.match(core, /sourceConsistencyOrWriteDrainVerifiedByTool:\s*false/u);
  assert.match(core, /physicalBackendOrVersionInventoryPerformed:\s*false/u);
  assert.match(core, /verifyEncryptedTar\(/u);
  assert.match(core, /objectSetSha256/u);
});
