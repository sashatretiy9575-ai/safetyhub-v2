export const PRODUCTION_PROJECT_REF = 'podkjjguhhdiecrgznoa';
export const PROTECTED_PROJECT_REFS = Object.freeze([
  PRODUCTION_PROJECT_REF,
  // Retain the previous production ref as permanently protected. A stale
  // operator environment must never turn an old SafetyHub project into a
  // destructive load-test target.
  'vezgxdooijznpjqrpvcv',
]);
export const DISPOSABLE_PROJECT_MARKER = 'DISPOSABLE SECURITY TEST';
export const LOCAL_CI_LOAD_TEST_MARKER = 'LOCAL DISPOSABLE SUPABASE ONLY';
export const LOCAL_CI_SUPABASE_URL = 'http://127.0.0.1:54321';
export const LOCAL_CI_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const CLEAN_LOAD_TEST_TABLES = Object.freeze([
  'profiles',
  'user_roles',
  'account_controls',
  'user_capabilities',
  'verified_identities',
  'test_attempts',
  'attestations',
  'certificates',
  'legal_acceptances',
  'admin_audit_log',
]);

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;

function refuse(message) {
  throw new Error(`Refusing destructive load seed: ${message}`);
}

function assertProjectRef(value, label) {
  if (typeof value !== 'string' || !PROJECT_REF_PATTERN.test(value)) {
    refuse(`${label} must be an exact 20-character lowercase Supabase project ref`);
  }
  return value;
}

function denyProductionRef(projectRef, label) {
  if (PROTECTED_PROJECT_REFS.includes(projectRef)) {
    refuse(`${label} is the hard-denied production project`);
  }
}

export function projectRefFromSupabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    refuse('NEXT_PUBLIC_SUPABASE_URL must be a valid URL');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    refuse('NEXT_PUBLIC_SUPABASE_URL must be an exact HTTPS Supabase project URL');
  }

  const match = /^([a-z0-9]{20})\.supabase\.co$/u.exec(url.hostname);
  if (!match) {
    refuse('NEXT_PUBLIC_SUPABASE_URL must use https://<project-ref>.supabase.co');
  }
  return match[1];
}

export function assertLoadTestTarget({ url, disposableRef, confirmation, marker }) {
  const targetRef = projectRefFromSupabaseUrl(url);
  denyProductionRef(targetRef, 'actual target ref');

  const expectedRef = assertProjectRef(disposableRef, 'SAFETYHUB_LOAD_TEST_PROJECT_REF');
  denyProductionRef(expectedRef, 'explicit disposable ref');

  if (typeof confirmation === 'string') {
    denyProductionRef(confirmation, 'confirmation ref');
  }
  if (confirmation !== expectedRef) {
    refuse('SAFETYHUB_LOAD_TEST_CONFIRM must exactly equal the explicit disposable ref');
  }
  if (marker !== DISPOSABLE_PROJECT_MARKER) {
    refuse(
      `SAFETYHUB_LOAD_TEST_MARKER must exactly equal ${JSON.stringify(DISPOSABLE_PROJECT_MARKER)}`,
    );
  }
  if (targetRef !== expectedRef) {
    refuse('actual target ref does not equal SAFETYHUB_LOAD_TEST_PROJECT_REF');
  }

  return targetRef;
}

export function assertLocalCiLoadTestTarget({
  url,
  databaseUrl,
  ci,
  githubActions,
  runnerEnvironment,
  marker,
}) {
  if (ci !== 'true' || githubActions !== 'true' || runnerEnvironment !== 'github-hosted') {
    refuse('local load mode is restricted to a fresh GitHub-hosted CI runner');
  }
  if (marker !== LOCAL_CI_LOAD_TEST_MARKER) {
    refuse(
      `SAFETYHUB_LOCAL_LOAD_MARKER must exactly equal ${JSON.stringify(LOCAL_CI_LOAD_TEST_MARKER)}`,
    );
  }
  if (url !== LOCAL_CI_SUPABASE_URL) {
    refuse(`local CI target must exactly equal ${LOCAL_CI_SUPABASE_URL}`);
  }
  if (databaseUrl !== LOCAL_CI_DATABASE_URL) {
    refuse('local CI database must be the exact disposable loopback database');
  }

  return 'local-ci';
}

export async function assertDisposableProjectMarker({
  projectRef,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  assertProjectRef(projectRef, 'target project ref');
  denyProductionRef(projectRef, 'target project ref');

  const token = accessToken?.trim();
  if (!token) {
    refuse('SUPABASE_ACCESS_TOKEN is required to verify the disposable project marker');
  }
  if (typeof fetchImpl !== 'function') {
    refuse('Supabase Management API verification is unavailable');
  }

  let response;
  try {
    response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    refuse('Supabase Management API project-marker verification failed');
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    refuse(`Supabase Management API project-marker verification failed${status}`);
  }

  let project;
  try {
    project = await response.json();
  } catch {
    refuse('Supabase Management API returned unreadable project metadata');
  }

  if (
    PROTECTED_PROJECT_REFS.includes(project?.ref) ||
    PROTECTED_PROJECT_REFS.includes(project?.id)
  ) {
    refuse('Management API metadata identifies the hard-denied production project');
  }
  if (project?.id !== projectRef) {
    refuse('Management API project metadata does not exactly match the target ref');
  }
  if (Object.hasOwn(project, 'ref') && project.ref !== projectRef) {
    refuse('Management API project metadata does not exactly match the target ref');
  }
  if (project?.name !== DISPOSABLE_PROJECT_MARKER) {
    refuse(`target project name must exactly equal ${JSON.stringify(DISPOSABLE_PROJECT_MARKER)}`);
  }
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse(`${label} did not return a trustworthy exact count`);
  }
  return value;
}

export async function assertCleanLoadTestBaseline(
  admin,
  { call = (operation) => operation() } = {},
) {
  let authResult;
  try {
    authResult = await call(
      () => admin.auth.admin.listUsers({ page: 1, perPage: 1 }),
      'AUTH_BASELINE_COUNT',
    );
  } catch {
    refuse('Auth baseline count failed');
  }
  if (authResult?.error) {
    refuse('Auth baseline count failed');
  }

  const users = authResult?.data?.users;
  const total = authResult?.data?.total;
  if (!Array.isArray(users)) {
    refuse('Auth baseline did not return a trustworthy user list');
  }
  assertNonnegativeInteger(total, 'Auth baseline');
  if (total !== 0 || users.length !== 0) {
    refuse(`clean Auth baseline required (found at least ${Math.max(total, users.length)})`);
  }

  const counts = [];
  for (const table of CLEAN_LOAD_TEST_TABLES) {
    let result;
    try {
      result = await call(
        () => admin.from(table).select('*', { count: 'exact', head: true }),
        `${table.toUpperCase()}_BASELINE_COUNT`,
      );
    } catch {
      refuse(`${table} baseline count failed`);
    }
    if (result?.error) {
      refuse(`${table} baseline count failed`);
    }
    counts.push([table, assertNonnegativeInteger(result?.count, `${table} baseline`)]);
  }

  const dirty = counts.filter(([, count]) => count !== 0);
  if (dirty.length > 0) {
    refuse(
      `clean data baseline required (${dirty
        .map(([table, count]) => `${table}=${count}`)
        .join(', ')})`,
    );
  }

  return Object.fromEntries([['auth.users', total], ...counts]);
}
