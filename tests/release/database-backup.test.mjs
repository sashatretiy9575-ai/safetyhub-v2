import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('database backup encrypts, verifies, and restores exact dump bytes', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows DPAPI contract is exercised on the release workstation.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-database-backup-test-'));
  try {
    const schema = path.join(root, 'schema.sql');
    const data = path.join(root, 'data.sql');
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
    assert.deepEqual(await readFile(path.join(restoredWithDpapi, 'schema.sql')), schemaBytes);
    assert.deepEqual(await readFile(path.join(restoredWithDpapi, 'data.sql')), dataBytes);

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
    assert.deepEqual(await readFile(path.join(restoredWithRecoveryKey, 'schema.sql')), schemaBytes);
    assert.deepEqual(await readFile(path.join(restoredWithRecoveryKey, 'data.sql')), dataBytes);
    const receipt = JSON.parse(await readFile(path.join(backup, 'receipt.json'), 'utf8'));
    assert.equal(receipt.portableRecovery.algorithm, 'aes-256-gcm');
    assert.match(await readFile(recoveryKey, 'utf8'), /^SAFETYHUB-RECOVERY-KEY-V1:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linked backup uses a read-only snapshot and never persists temporary credentials', async () => {
  const source = await readFile('scripts/backup-linked-database.mjs', 'utf8');
  assert.match(source, /repeatable read read only deferrable/u);
  assert.match(source, /pg_export_snapshot/u);
  assert.match(source, /--format=custom/u);
  assert.match(source, /rehearseApplicationRestore/u);
  assert.match(source, /--disable-triggers/u);
  assert.match(source, /set local role postgres/u);
  assert.match(source, /\['public', 'private', 'auth', 'storage'\]/u);
  assert.match(source, /connection\.PGPASSWORD = ''/u);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*PGPASSWORD/u);
  assert.match(source, /restore-database-backup\.mjs/u);
  assert.match(source, /archiveListVerification: 'passed'/u);
  assert.match(source, /portableRecoveryVerification: 'passed'/u);
  assert.match(source, /--recovery-key-output/u);
  assert.match(source, /--recovery-key-file/u);
  assert.match(source, /storageObjectSetSha256/u);
  assert.match(source, /rawObjectMetadata: 'encrypted:data\.dump'/u);
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
