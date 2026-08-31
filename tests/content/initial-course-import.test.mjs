import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executeInitialImport,
  linkedEnvironment,
  parseCliArguments,
} from '../../scripts/initial-course-import.mjs';

const catalogHash = '11b5486025cbb94c02ea0ed021ce8a8afc3f1e4c997c9cccbf5497e8fb42c026';
const projectRef = 'abcdefghijklmnopqrst';
const actorId = '11111111-1111-4111-8111-111111111111';
const confirmation = `INITIAL-IMPORT:${projectRef}:${catalogHash}`;
const read = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

test('initial import CLI requires exact project, catalog and explicit confirmation', () => {
  const parsed = parseCliArguments([
    '--project-ref',
    projectRef,
    '--actor-id',
    actorId,
    '--catalog-hash',
    catalogHash,
    '--confirm',
    confirmation,
  ]);
  assert.equal(parsed.projectRef, projectRef);
  assert.equal(parsed.actorId, actorId);
  assert.equal(parsed.catalogHash, catalogHash);
  assert.throws(
    () =>
      parseCliArguments([
        '--project-ref',
        projectRef,
        '--actor-id',
        actorId,
        '--catalog-hash',
        catalogHash,
        '--confirm',
        'yes',
      ]),
    /INVALID_CONFIRMATION/u,
  );
});

test('linked environment fails closed when URL project ref differs', () => {
  assert.deepEqual(
    linkedEnvironment(
      {
        NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
        SUPABASE_SECRET_KEY: 'server-secret',
      },
      projectRef,
    ),
    { url: `https://${projectRef}.supabase.co`, secret: 'server-secret' },
  );
  assert.throws(
    () =>
      linkedEnvironment(
        {
          NEXT_PUBLIC_SUPABASE_URL: 'https://differentprojectrefx.supabase.co',
          SUPABASE_SECRET_KEY: 'server-secret',
        },
        projectRef,
      ),
    /PROJECT_REF_MISMATCH/u,
  );
});

test('database workflow is service-only, phased, idempotent and receipt-bounded', async () => {
  const [migration, script] = await Promise.all([
    read('supabase/migrations/20260831122000_initial_course_import_workflow.sql'),
    read('scripts/initial-course-import.mjs'),
  ]);
  for (const routine of [
    'begin_initial_course_import',
    'stage_initial_course_import',
    'prepare_initial_course_import',
    'activate_initial_course_import',
    'complete_initial_course_import',
  ]) {
    assert.match(migration, new RegExp(`create function public\\.${routine}`, 'u'));
  }
  assert.match(migration, /grant execute[\s\S]*to service_role/u);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:anon|authenticated)/u);
  assert.match(migration, /INITIAL_IMPORT_TARGET_NOT_EMPTY/u);
  assert.match(migration, /private\.publish_course_revision_v3_unmetered/u);
  assert.match(migration, /catalogChecksum/u);
  assert.match(script, /course-presentations-staging/u);
  assert.match(script, /upsert:\s*false/u);
  assert.match(script, /flag:\s*'wx'/u);
  assert.doesNotMatch(script, /console\.log\([^\n]*(?:secret|payload|correctOption)/u);
});

test('initial import orchestrates staging, managed activation and post-activation cleanup', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-initial-import-'));
  const receiptPath = path.join(temporaryRoot, 'receipt.json');
  const operationId = '22222222-2222-4222-8222-222222222222';
  const batchId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  const repository = {
    async assertPrivateBucket(bucket) {
      calls.push(['bucket', bucket]);
    },
    async ensureObject(bucket, objectPath) {
      calls.push(['object', bucket, objectPath]);
      return 'uploaded';
    },
    async removeObjects(bucket, objectPaths) {
      calls.push(['remove', bucket, objectPaths]);
    },
    async rpc(name) {
      calls.push(['rpc', name]);
      if (name === 'begin_initial_course_import') {
        return { operationId, status: 'begun', batchId: null };
      }
      if (name === 'stage_initial_course_import') {
        return { operationId, status: 'staged', batchId: null };
      }
      if (name === 'prepare_initial_course_import') {
        return { operationId, status: 'prepared', batchId };
      }
      if (name === 'activate_initial_course_import') {
        return {
          operationId,
          status: 'activated',
          batchId,
          catalogChecksum: '9d34b6b4f106b6886a540e0b67c2f7be27ffa6b1e3e4656013e6192ed39c228a',
          published: { courses: 5, revisions: 5, variants: 15, questions: 150, options: 600 },
          history: { attempts: 0, attestations: 0, certificates: 0 },
        };
      }
      if (name === 'complete_initial_course_import') {
        return { operationId, status: 'completed', batchId };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };

  try {
    const result = await executeInitialImport({
      options: {
        projectRef,
        actorId,
        catalogHash,
        confirmation,
        receiptPath,
      },
      repository,
      root: path.resolve('.'),
    });
    assert.equal(result.receipt.status, 'completed');
    assert.equal(result.receipt.assets.presentationCount, 5);
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'rpc').map(([, name]) => name),
      [
        'begin_initial_course_import',
        'stage_initial_course_import',
        'prepare_initial_course_import',
        'activate_initial_course_import',
        'complete_initial_course_import',
      ],
    );
    assert.equal(calls.filter(([kind]) => kind === 'object').length, 20);
    assert.equal(calls.filter(([kind]) => kind === 'remove').length, 5);
    const persisted = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(persisted.catalogHash, catalogHash);
    assert.equal(Object.hasOwn(persisted, 'actorId'), false);
    assert.equal(Object.hasOwn(persisted, 'secret'), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
