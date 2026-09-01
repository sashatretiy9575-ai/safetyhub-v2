import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CLEAN_LOAD_TEST_TABLES,
  DISPOSABLE_PROJECT_MARKER,
  LOCAL_CI_DATABASE_URL,
  LOCAL_CI_LOAD_TEST_MARKER,
  LOCAL_CI_SEED_AUDIT_ROW_COUNT,
  LOCAL_CI_SUPABASE_URL,
  PRODUCTION_PROJECT_REF,
  PROTECTED_PROJECT_REFS,
  assertCleanLoadTestBaseline,
  assertDisposableProjectMarker,
  assertLocalCiCleanLoadTestBaseline,
  assertLocalCiLoadTestTarget,
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

function validLocalCiTarget(overrides = {}) {
  return {
    url: LOCAL_CI_SUPABASE_URL,
    databaseUrl: LOCAL_CI_DATABASE_URL,
    ci: 'true',
    githubActions: 'true',
    runnerEnvironment: 'github-hosted',
    marker: LOCAL_CI_LOAD_TEST_MARKER,
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

test('local load target is pinned to the exact GitHub-hosted loopback endpoint', () => {
  assert.equal(assertLocalCiLoadTestTarget(validLocalCiTarget()), 'local-ci');

  for (const candidate of [
    validLocalCiTarget({ url: 'http://localhost:54321' }),
    validLocalCiTarget({ url: 'https://127.0.0.1:54321' }),
    validLocalCiTarget({ url: `${LOCAL_CI_SUPABASE_URL}/rest/v1` }),
    validLocalCiTarget({ url: `${LOCAL_CI_SUPABASE_URL}?target=hosted` }),
    validLocalCiTarget({ url: DISPOSABLE_URL }),
    validLocalCiTarget({
      databaseUrl: 'postgresql://postgres:postgres@podkjjguhhdiecrgznoa.supabase.co:5432/postgres',
    }),
    validLocalCiTarget({ databaseUrl: `${LOCAL_CI_DATABASE_URL}?target=hosted` }),
    validLocalCiTarget({ ci: 'false' }),
    validLocalCiTarget({ githubActions: 'false' }),
    validLocalCiTarget({ runnerEnvironment: 'self-hosted' }),
    validLocalCiTarget({ marker: DISPOSABLE_PROJECT_MARKER }),
  ]) {
    assert.throws(() => assertLocalCiLoadTestTarget(candidate), /Refusing destructive/u);
  }
});

test('every current or historical production ref is denied in every ref-bearing input', () => {
  for (const protectedRef of PROTECTED_PROJECT_REFS) {
    for (const candidate of [
      validTarget({ url: `https://${protectedRef}.supabase.co` }),
      validTarget({ disposableRef: protectedRef }),
      validTarget({ confirmation: protectedRef }),
      {
        url: `https://${protectedRef}.supabase.co`,
        disposableRef: protectedRef,
        confirmation: protectedRef,
        marker: DISPOSABLE_PROJECT_MARKER,
      },
    ]) {
      assert.throws(() => assertLoadTestTarget(candidate), /hard-denied production project/u);
    }
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

test('local CI accepts only the exact deterministic seed audit receipt count', async () => {
  const counts = await assertLocalCiCleanLoadTestBaseline(
    baselineAdmin({ counts: { admin_audit_log: LOCAL_CI_SEED_AUDIT_ROW_COUNT } }),
  );
  assert.equal(counts.admin_audit_log, LOCAL_CI_SEED_AUDIT_ROW_COUNT);

  for (const count of [LOCAL_CI_SEED_AUDIT_ROW_COUNT - 1, LOCAL_CI_SEED_AUDIT_ROW_COUNT + 1]) {
    await assert.rejects(
      assertLocalCiCleanLoadTestBaseline(baselineAdmin({ counts: { admin_audit_log: count } })),
      new RegExp(`admin_audit_log=${count},expected=${LOCAL_CI_SEED_AUDIT_ROW_COUNT}`, 'u'),
    );
  }

  await assert.rejects(
    assertLocalCiCleanLoadTestBaseline(
      baselineAdmin({
        counts: { admin_audit_log: LOCAL_CI_SEED_AUDIT_ROW_COUNT, profiles: 1 },
      }),
    ),
    /profiles=1,expected=0/u,
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
    /profiles=1,expected=0, test_attempts=3,expected=0, admin_audit_log=2,expected=0/u,
  );
});

test('load harness completes every safety preflight before its first seed write', async () => {
  const [harness, safety, workflow] = await Promise.all([
    readFile(new URL('../../scripts/load-test-supabase.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/load-test-safety.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  ]);

  const targetGuard = harness.indexOf('assertLoadTestTarget({');
  const markerGuard = harness.indexOf('await assertDisposableProjectMarker({');
  const localBaselineGuard = harness.indexOf('await assertLocalCiCleanLoadTestBaseline(admin);');
  const baselineGuard = harness.indexOf('await assertCleanLoadTestBaseline(admin);');
  const localFixtureGuard = harness.indexOf(
    'await prepareLocalCiLocaleFixture(process.env.SAFETYHUB_LOCAL_DATABASE_URL);',
    baselineGuard,
  );
  const zhRolloutEnable = harness.indexOf("p_feature_name: 'zh_username_password'", baselineGuard);
  const firstSeedDispatch = harness.indexOf('createZhLoadTestUser(admin, index', baselineGuard);

  assert.ok(targetGuard >= 0);
  assert.ok(markerGuard > targetGuard);
  assert.ok(localBaselineGuard > markerGuard);
  assert.ok(baselineGuard > markerGuard);
  assert.ok(localFixtureGuard > baselineGuard);
  assert.ok(zhRolloutEnable > localFixtureGuard);
  assert.ok(firstSeedDispatch > localFixtureGuard);
  assert.ok(firstSeedDispatch > zhRolloutEnable);
  assert.ok(firstSeedDispatch > baselineGuard);
  assert.match(harness, /process\.env\.GITHUB_ACTIONS === 'true' && targetMode !== 'local-ci'/u);
  assert.match(harness, /SUPABASE_ACCESS_TOKEN must not be present in local-ci load mode/u);
  assert.match(harness, /LOCAL_CI_CONTENT_FIXTURE_FAILED/u);
  assert.match(harness, /LOCAL_CI_FOUR_LOCALE_FIXTURE_INCOMPLETE/u);
  assert.match(harness, /if \(process\.env\.SAFETYHUB_LOAD_TARGET === 'local-ci'\) return/u);
  assert.match(harness, /SAFETYHUB_LOAD_RESUME !== undefined/u);
  assert.match(harness, /const MAX_MAU_PROFILE = 100/u);
  assert.match(harness, /const LOAD_WAVES = \[25, 50, 100\]/u);
  assert.match(harness, /positiveInteger\([\s\S]*'SAFETYHUB_LOAD_USERS'[\s\S]*MAX_MAU_PROFILE/u);
  assert.doesNotMatch(harness, /EXPECTED_PROJECT_REF/u);
  for (const protectedRef of PROTECTED_PROJECT_REFS) {
    assert.match(safety, new RegExp(protectedRef, 'u'));
  }
  assert.match(safety, /targetRef !== expectedRef/u);
  assert.match(safety, /project\?\.name !== DISPOSABLE_PROJECT_MARKER/u);
  assert.match(safety, /url !== LOCAL_CI_SUPABASE_URL/u);
  assert.match(safety, /databaseUrl !== LOCAL_CI_DATABASE_URL/u);
  assert.match(safety, /runnerEnvironment !== 'github-hosted'/u);
  assert.doesNotMatch(harness, /\$\{user\.id\}\/avatar\.webp/u);
  assert.match(harness, /complete_zh_username_registration/u);
  assert.match(harness, /get_zh_username_login_mapping/u);
  assert.match(harness, /get_zh_username_password_rollout_enabled/u);
  assert.match(harness, /safetyhub_auth_kind: 'zh_username_password'/u);
  assert.match(harness, /client\.auth\.signInWithPassword\(/u);
  assert.match(harness, /options: captchaToken \? \{ captchaToken \} : undefined/u);
  assert.match(
    harness,
    /const LOCAL_CI_TURNSTILE_DUMMY_TOKEN = 'XXXX\.DUMMY\.TOKEN\.XXXX'/u,
  );
  assert.match(
    harness,
    /targetMode === 'local-ci' \? LOCAL_CI_TURNSTILE_DUMMY_TOKEN : undefined/u,
  );
  assert.match(harness, /ZH_PASSWORD_SIGN_IN_FAILED_\$\{boundedAuthErrorEvidence\(signedIn\.error\)\}/u);
  assert.match(
    harness,
    /HTTP_\$\{statusCategory\}_CODE_\$\{codeCategory\}_CATEGORY_\$\{failureCategory\}/u,
  );
  assert.doesNotMatch(harness, /signedIn\.error\.message\}\)/u);
  assert.doesNotMatch(
    harness,
    /prepare_zh_registration_operation|attach_zh_registration_auth_user|mark_zh_registration_storage_written|finalize_zh_registration|prepare_zh_authentication_challenge|get_zh_authentication_context|complete_zh_authentication|verifyRegistrationResponse|verifyAuthenticationResponse|createSoftwareCredential|runZhAssertion|generateLink|verifyOtp|software-webauthn|simplewebauthn/u,
  );
  assert.match(harness, /list_published_courses_locale/u);
  assert.match(harness, /get_published_course_locale/u);
  assert.match(harness, /get_approved_course_presentation_locale/u);
  assert.match(harness, /approved presentation metadata contract mismatch/u);
  assert.match(harness, /presentationReadP95Ms/u);
  assert.match(harness, /start_test_attempt_locale/u);
  assert.match(harness, /list_admin_notification_inbox/u);
  assert.match(harness, /claim_notification_deliveries/u);
  assert.match(harness, /get_certificate_download_payload/u);
  assert.match(harness, /zhUsernamePasswordRegistration:/u);
  assert.match(harness, /zhPasswordLoginWaveResults/u);
  assert.doesNotMatch(harness, /throw new Error\([^\n]*\$\{email\}/u);
  assert.doesNotMatch(harness, /updateUserById\([^)]*password/u);

  const localJob = workflow.slice(workflow.indexOf('  local-capacity-load:'));
  assert.match(localJob, /node-version: 24/u);
  assert.match(localJob, /SAFETYHUB_LOAD_TARGET: local-ci/u);
  assert.match(localJob, /SAFETYHUB_LOCAL_LOAD_MARKER: LOCAL DISPOSABLE SUPABASE ONLY/u);
  assert.match(localJob, /SAFETYHUB_LOAD_USERS: '100'/u);
  assert.match(localJob, /SAFETYHUB_LOAD_SESSIONS: '100'/u);
  assert.match(localJob, /\[\[ "\$API_URL" != "http:\/\/127\.0\.0\.1:54321" \]\]/u);
  assert.match(
    localJob,
    /\[\[ "\$DB_URL" != "postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres" \]\]/u,
  );
  assert.match(localJob, /SAFETYHUB_LOCAL_DATABASE_URL=\$DB_URL/u);
  assert.match(localJob, /env -u SUPABASE_ACCESS_TOKEN npm run test:load/u);
  assert.doesNotMatch(
    localJob,
    /secrets\.|SAFETYHUB_LOAD_TEST_PROJECT_REF|SUPABASE_ACCESS_TOKEN=/u,
  );
});
