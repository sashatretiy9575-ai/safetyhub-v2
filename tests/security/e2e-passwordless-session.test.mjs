import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  prepareReleaseE2eAuth,
  sanitizePasswordlessBrowserState,
} from '../../scripts/e2e-passwordless-session.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

function state(cookieName = 'sb-local-auth-token') {
  return {
    cookies: [
      {
        name: cookieName,
        value: 'opaque-session-cookie-for-static-harness-test',
        domain: 'untrusted.example',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'unrelated',
        value: 'discard-me',
        domain: 'untrusted.example',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: 'https://untrusted.example',
        localStorage: [{ name: 'theme', value: 'dark' }],
      },
    ],
  };
}

test('E2E state accepts only HttpOnly Supabase auth cookies and rewrites them for the target origin', () => {
  const sanitized = sanitizePasswordlessBrowserState(state(), 'https://preview.example.test');

  assert.deepEqual(sanitized.origins, []);
  assert.equal(sanitized.cookies.length, 1);
  assert.deepEqual(sanitized.cookies[0], {
    name: 'sb-local-auth-token',
    value: 'opaque-session-cookie-for-static-harness-test',
    domain: 'preview.example.test',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
});

test('E2E state fails closed for a missing HttpOnly flag, no session, duplicate chunk, or expired session', () => {
  const notHttpOnly = state();
  notHttpOnly.cookies[0].httpOnly = false;
  assert.throws(
    () => sanitizePasswordlessBrowserState(notHttpOnly, 'http://localhost:3100'),
    /E2E_AUTH_STATE_COOKIE_NOT_HTTP_ONLY/u,
  );
  assert.throws(
    () => sanitizePasswordlessBrowserState({ cookies: [] }, 'http://localhost:3100'),
    /E2E_AUTH_STATE_MISSING_SESSION/u,
  );
  const duplicate = state();
  duplicate.cookies.push({ ...duplicate.cookies[0] });
  assert.throws(
    () => sanitizePasswordlessBrowserState(duplicate, 'http://localhost:3100'),
    /E2E_AUTH_STATE_DUPLICATE_COOKIE/u,
  );
  const expired = state();
  expired.cookies[0].expires = 1;
  assert.throws(
    () => sanitizePasswordlessBrowserState(expired, 'http://localhost:3100'),
    /E2E_AUTH_STATE_EXPIRED/u,
  );
});

test('remote release accepts only an intentionally supplied external state pair and rebuilds ephemeral minimal files', async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'safetyhub-e2e-state-test-'));
  const adminPath = path.join(stateDirectory, 'admin.json');
  const participantPath = path.join(stateDirectory, 'participant.json');
  await writeFile(adminPath, JSON.stringify(state('sb-project-auth-token.0')));
  await writeFile(participantPath, JSON.stringify(state('sb-project-auth-token')));

  let prepared;
  try {
    prepared = await prepareReleaseE2eAuth({
      environment: {
        PLAYWRIGHT_BASE_URL: 'https://preview.example.test',
        E2E_ADMIN_STORAGE_STATE: adminPath,
        E2E_PARTICIPANT_STORAGE_STATE: participantPath,
      },
      repositoryRoot: root,
    });
    const adminState = JSON.parse(await readFile(prepared.adminStatePath, 'utf8'));
    const participantState = JSON.parse(await readFile(prepared.participantStatePath, 'utf8'));

    assert.deepEqual(adminState.origins, []);
    assert.deepEqual(participantState.origins, []);
    assert.deepEqual(
      adminState.cookies.map((cookie) => cookie.name),
      ['sb-project-auth-token.0'],
    );
    assert.deepEqual(
      participantState.cookies.map((cookie) => cookie.name),
      ['sb-project-auth-token'],
    );
    assert.equal(adminState.cookies[0].domain, 'preview.example.test');
    assert.equal(participantState.cookies[0].httpOnly, true);
    assert.equal(
      prepared.sensitiveValues.includes('opaque-session-cookie-for-static-harness-test'),
      true,
    );
  } finally {
    await prepared?.cleanup();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('remote release cannot mint a privileged browser state with a service key', async () => {
  await assert.rejects(
    prepareReleaseE2eAuth({
      environment: {
        PLAYWRIGHT_BASE_URL: 'https://preview.example.test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
        SUPABASE_SECRET_KEY: 'server-test-key',
        E2E_ADMIN_EMAIL: 'admin@example.test',
        E2E_PARTICIPANT_EMAIL: 'participant@example.test',
      },
      repositoryRoot: root,
    }),
    /E2E_AUTH_REMOTE_SESSION_BOOTSTRAP_FORBIDDEN/u,
  );
});

test('remote release requires HTTPS before reading any supplied test state', async () => {
  await assert.rejects(
    prepareReleaseE2eAuth({
      environment: { PLAYWRIGHT_BASE_URL: 'http://preview.example.test' },
      repositoryRoot: root,
    }),
    /E2E_AUTH_REMOTE_HTTPS_REQUIRED/u,
  );
});

test('authenticated workspace and release runner retain no legacy password login assumption', async () => {
  const [workspace, runner, sessionHarness, capture] = await Promise.all([
    readFile(new URL('../../e2e/authenticated-workspaces.spec.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/run-e2e-release.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/e2e-passwordless-session.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/capture-e2e-otp-session.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workspace, /E2E_ADMIN_STORAGE_STATE/u);
  assert.match(workspace, /E2E_PARTICIPANT_STORAGE_STATE/u);
  assert.match(workspace, /test\.use\(\{ storageState: adminStorageState \}\)/u);
  assert.match(workspace, /test\.use\(\{ storageState: participantStorageState \}\)/u);
  assert.doesNotMatch(
    workspace,
    /E2E_PASSWORD|SAFETYHUB_SEED_PASSWORD|signInWithPassword|\/api\/auth\/login|type="password"/u,
  );

  assert.match(runner, /prepareReleaseE2eAuth\(\)/u);
  assert.match(runner, /sessionStates\.sensitiveValues/u);
  assert.doesNotMatch(runner, /E2E_PASSWORD|SAFETYHUB_SEED_PASSWORD|signInWithPassword/u);

  assert.match(sessionHarness, /auth\.admin\.generateLink\(/u);
  assert.match(sessionHarness, /auth\.verifyOtp\(\{ email, token: emailOtp, type: 'email' \}\)/u);
  assert.match(sessionHarness, /E2E_AUTH_REMOTE_SESSION_BOOTSTRAP_FORBIDDEN/u);
  assert.doesNotMatch(sessionHarness, /signInWithPassword|password\s*:/u);

  assert.match(capture, /E2E_OTP_CAPTURE_WAITING_FOR_INTERACTIVE_LOGIN/u);
  assert.match(capture, /sanitizePasswordlessBrowserState/u);
  assert.doesNotMatch(capture, /signInWithPassword|password\s*:/u);
});
