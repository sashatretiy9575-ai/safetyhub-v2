import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CLEAN_LOAD_TEST_TABLES,
  DISPOSABLE_PROJECT_MARKER,
  PRODUCTION_PROJECT_REF,
  assertCleanLoadTestBaseline,
  assertDisposableProjectMarker,
  assertLoadTestTarget,
  projectRefFromSupabaseUrl,
} from '../../scripts/load-test-safety.mjs';

const DISPOSABLE_REF = 'abcdefghijklmnopqrst';
const DISPOSABLE_URL = `https://${DISPOSABLE_REF}.supabase.co`;

function validTarget(overrides = {}) {
  return {
    url: DISPOSABLE_URL,
    disposableRef: DISPOSABLE_REF,
    confirmation: DISPOSABLE_REF,
    marker: DISPOSABLE_PROJECT_MARKER,
    ...overrides,
  };
}

function response(project, overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => project,
    ...overrides,
  };
}

function baselineAdmin({
  users = [],
  total = 0,
  authError = null,
  counts = {},
  tableErrors = {},
} = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      admin: {
        async listUsers(options) {
          calls.push({ operation: 'listUsers', options });
          return { data: { users, total }, error: authError };
        },
      },
    },
    from(table) {
      return {
        async select(columns, options) {
          calls.push({ operation: 'select', table, columns, options });
          return {
            count: Object.hasOwn(counts, table) ? counts[table] : 0,
            error: tableErrors[table] ?? null,
          };
        },
      };
    },
  };
}

test('valid target requires one exact hosted ref, matching confirmation, and exact marker', () => {
  assert.equal(projectRefFromSupabaseUrl(DISPOSABLE_URL), DISPOSABLE_REF);
  assert.equal(assertLoadTestTarget(validTarget()), DISPOSABLE_REF);
});

test('production is unconditionally denied in every ref-bearing input', () => {
  for (const candidate of [
    validTarget({ url: `https://${PRODUCTION_PROJECT_REF}.supabase.co` }),
    validTarget({ disposableRef: PRODUCTION_PROJECT_REF }),
    validTarget({ confirmation: PRODUCTION_PROJECT_REF }),
    {
      url: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      disposableRef: PRODUCTION_PROJECT_REF,
      confirmation: PRODUCTION_PROJECT_REF,
      marker: DISPOSABLE_PROJECT_MARKER,
    },
  ]) {
    assert.throws(() => assertLoadTestTarget(candidate), /hard-denied production project/u);
  }
});

test('empty and malformed explicit refs fail closed', () => {
  for (const disposableRef of [
    undefined,
    '',
    ' ',
    'short',
    'ABCDEFGHIJKLMNOPQRST',
    'abcdefghijklmnopqrs-',
    'abcdefghijklmnopqrs_',
    'https://abcdefghijklmnopqrst.supabase.co',
    `${DISPOSABLE_REF}\n`,
  ]) {
    assert.throws(
      () => assertLoadTestTarget(validTarget({ disposableRef, confirmation: disposableRef })),
      /exact 20-character lowercase Supabase project ref/u,
    );
  }
});

test('malformed, custom, and decorated target URLs fail closed', () => {
  for (const url of [
    undefined,
    '',
    'not-a-url',
    `http://${DISPOSABLE_REF}.supabase.co`,
    `https://${DISPOSABLE_REF}.supabase.co.evil.example`,
    `https://api.example.test`,
    `https://user@${DISPOSABLE_REF}.supabase.co`,
    `https://${DISPOSABLE_REF}.supabase.co:8443`,
    `https://${DISPOSABLE_REF}.supabase.co/rest/v1`,
    `https://${DISPOSABLE_REF}.supabase.co/?target=other`,
    `https://${DISPOSABLE_REF}.supabase.co/#other`,
  ]) {
    assert.throws(() => assertLoadTestTarget(validTarget({ url })), /Refusing destructive/u);
  }
});

test('target, confirmation, and high-friction marker comparisons are exact', () => {
  const otherRef = 'bcdefghijklmnopqrstu';
  assert.throws(
    () =>
      assertLoadTestTarget(
        validTarget({
          disposableRef: otherRef,
          confirmation: otherRef,
        }),
      ),
    /actual target ref does not equal/u,
  );

  for (const confirmation of [undefined, '', ` ${DISPOSABLE_REF}`, `${DISPOSABLE_REF} `]) {
    assert.throws(
      () => assertLoadTestTarget(validTarget({ confirmation })),
      /must exactly equal the explicit disposable ref/u,
    );
  }

  for (const marker of [
    undefined,
    '',
    DISPOSABLE_PROJECT_MARKER.toLowerCase(),
    ` ${DISPOSABLE_PROJECT_MARKER}`,
    `${DISPOSABLE_PROJECT_MARKER} `,
  ]) {
    assert.throws(
      () => assertLoadTestTarget(validTarget({ marker })),
      /SAFETYHUB_LOAD_TEST_MARKER must exactly equal/u,
    );
  }
});

test('Management API metadata must prove the exact ref and disposable project name', async () => {
  let request;
  await assertDisposableProjectMarker({
    projectRef: DISPOSABLE_REF,
    accessToken: 'test-management-token',
      fetchImpl: async (...args) => {
      request = args;
      return response({
        id: DISPOSABLE_REF,
        name: DISPOSABLE_PROJECT_MARKER,
      });
    },
  });

  assert.equal(request[0], `https://api.supabase.com/v1/projects/${DISPOSABLE_REF}`);
  assert.equal(request[1].headers.authorization, 'Bearer test-management-token');
  assert.equal(request[1].headers.accept, 'application/json');
  assert.ok(request[1].signal instanceof AbortSignal);
});

test('project-marker verification fails closed on missing access or unverifiable metadata', async () => {
  await assert.rejects(
    assertDisposableProjectMarker({ projectRef: DISPOSABLE_REF, accessToken: '' }),
    /SUPABASE_ACCESS_TOKEN is required/u,
  );

  await assert.rejects(
    assertDisposableProjectMarker({
      projectRef: DISPOSABLE_REF,
      accessToken: 'token',
      fetchImpl: async () => {
        throw new Error('network detail must not be trusted');
      },
    }),
    /project-marker verification failed/u,
  );

  await assert.rejects(
    assertDisposableProjectMarker({
      projectRef: DISPOSABLE_REF,
      accessToken: 'token',
      fetchImpl: async () => response(null, { ok: false, status: 403 }),
    }),
    /HTTP 403/u,
  );

  await assert.rejects(
    assertDisposableProjectMarker({
      projectRef: DISPOSABLE_REF,
      accessToken: 'token',
      fetchImpl: async () => response(null, { json: async () => Promise.reject(new Error('bad')) }),
    }),
    /unreadable project metadata/u,
  );

  for (const project of [
    { id: 'bcdefghijklmnopqrstu', name: DISPOSABLE_PROJECT_MARKER },
    { id: DISPOSABLE_REF, ref: 'bcdefghijklmnopqrstu', name: DISPOSABLE_PROJECT_MARKER },
    { id: DISPOSABLE_REF, ref: DISPOSABLE_REF, name: 'SafetyHub' },
    {
      id: PRODUCTION_PROJECT_REF,
      ref: PRODUCTION_PROJECT_REF,
      name: DISPOSABLE_PROJECT_MARKER,
    },
  ]) {
    await assert.rejects(
      assertDisposableProjectMarker({
        projectRef: DISPOSABLE_REF,
        accessToken: 'token',
        fetchImpl: async () => response(project),
      }),
      /Refusing destructive load seed/u,
    );
  }
});

test('clean preflight uses exact head counts for Auth and every mutable user-data table', async () => {
  const admin = baselineAdmin();
  const counts = await assertCleanLoadTestBaseline(admin);

  assert.deepEqual(counts, {
    'auth.users': 0,
    ...Object.fromEntries(CLEAN_LOAD_TEST_TABLES.map((table) => [table, 0])),
  });
  assert.deepEqual(admin.calls[0], {
    operation: 'listUsers',
    options: { page: 1, perPage: 1 },
  });
  assert.deepEqual(
    admin.calls.slice(1).map(({ operation, table, columns, options }) => ({
      operation,
      table,
      columns,
      options,
    })),
    CLEAN_LOAD_TEST_TABLES.map((table) => ({
      operation: 'select',
      table,
      columns: '*',
      options: { count: 'exact', head: true },
    })),
  );
});

test('Auth baseline rejects both a reported total and a returned first-page user', async () => {
  await assert.rejects(
    assertCleanLoadTestBaseline(baselineAdmin({ total: 2 })),
    /clean Auth baseline required/u,
  );
  await assert.rejects(
    assertCleanLoadTestBaseline(baselineAdmin({ total: 0, users: [{ id: 'present' }] })),
    /clean Auth baseline required/u,
  );
});

test('Auth and data baseline errors, unknown counts, and nonzero rows all fail closed', async () => {
  await assert.rejects(
    assertCleanLoadTestBaseline(baselineAdmin({ authError: new Error('denied') })),
    /Auth baseline count failed/u,
  );
  await assert.rejects(
    assertCleanLoadTestBaseline(baselineAdmin({ total: null })),
    /trustworthy exact count/u,
  );
  await assert.rejects(
    assertCleanLoadTestBaseline(baselineAdmin({ counts: { profiles: null } })),
    /profiles baseline did not return a trustworthy exact count/u,
  );
  await assert.rejects(
    assertCleanLoadTestBaseline(
      baselineAdmin({ tableErrors: { attestations: new Error('denied') } }),
    ),
    /attestations baseline count failed/u,
  );
  await assert.rejects(
    assertCleanLoadTestBaseline(
      baselineAdmin({ counts: { profiles: 1, test_attempts: 3, admin_audit_log: 2 } }),
    ),
    /profiles=1, test_attempts=3, admin_audit_log=2/u,
  );
});

test('load harness completes every safety preflight before its first seed write', async () => {
  const [harness, safety] = await Promise.all([
    readFile(new URL('../../scripts/load-test-supabase.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/load-test-safety.mjs', import.meta.url), 'utf8'),
  ]);

  const targetGuard = harness.indexOf('assertLoadTestTarget({');
  const markerGuard = harness.indexOf('await assertDisposableProjectMarker({');
  const baselineGuard = harness.indexOf('await assertCleanLoadTestBaseline(admin);');
  const firstSeedWrite = harness.indexOf('admin.auth.admin.createUser({');

  assert.ok(targetGuard >= 0);
  assert.ok(markerGuard > targetGuard);
  assert.ok(baselineGuard > markerGuard);
  assert.ok(firstSeedWrite > baselineGuard);
  assert.match(harness, /SAFETYHUB_LOAD_RESUME !== undefined/u);
  assert.doesNotMatch(harness, /EXPECTED_PROJECT_REF/u);
  assert.match(safety, new RegExp(PRODUCTION_PROJECT_REF, 'u'));
  assert.match(safety, /targetRef !== expectedRef/u);
  assert.match(safety, /project\?\.name !== DISPOSABLE_PROJECT_MARKER/u);
  assert.doesNotMatch(harness, /\$\{user\.id\}\/avatar\.webp/u);
  assert.match(harness, /begin_profile_avatar_upload/u);
  assert.match(harness, /finish_profile_avatar_storage_write/u);
  assert.match(harness, /mark_profile_avatar_staged/u);
  assert.match(harness, /finalize_profile_avatar_upload/u);
  assert.match(harness, /upsert: false/u);
});
