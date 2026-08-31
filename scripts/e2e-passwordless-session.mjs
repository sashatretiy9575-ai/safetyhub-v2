import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AUTH_COOKIE_NAME = /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/iu;
const MAX_STORAGE_STATE_BYTES = 64 * 1024;
const SESSION_STATE_DIRECTORY_PREFIX = 'safetyhub-e2e-otp-';
const MAX_COOKIE_VALUE_LENGTH = 16 * 1024;

function fail(code) {
  throw new Error(code);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedEmail(value, code) {
  if (typeof value !== 'string') fail(code);
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) fail(code);
  return email;
}

function isRepositoryChild(repositoryRoot, candidate) {
  const relative = path.relative(repositoryRoot, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeTargetOrigin(value, code) {
  if (typeof value !== 'string' || !value.trim()) fail(code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    fail(code);
  }
  return parsed;
}

function stateExpiry(value) {
  if (value === undefined || value === null || value === -1) return -1;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value))
    fail('E2E_AUTH_STATE_COOKIE_INVALID');
  if (value <= Math.floor(Date.now() / 1_000)) fail('E2E_AUTH_STATE_EXPIRED');
  return value;
}

function canonicalCookie(cookie, targetOrigin) {
  if (!isRecord(cookie)) fail('E2E_AUTH_STATE_COOKIE_INVALID');
  if (typeof cookie.name !== 'string' || !AUTH_COOKIE_NAME.test(cookie.name)) {
    fail('E2E_AUTH_STATE_COOKIE_INVALID');
  }
  if (
    typeof cookie.value !== 'string' ||
    cookie.value.length === 0 ||
    cookie.value.length > MAX_COOKIE_VALUE_LENGTH ||
    /[\r\n]/u.test(cookie.value)
  ) {
    fail('E2E_AUTH_STATE_COOKIE_INVALID');
  }

  const options = isRecord(cookie.options) ? cookie.options : cookie;
  if (options.httpOnly !== true) fail('E2E_AUTH_STATE_COOKIE_NOT_HTTP_ONLY');

  return {
    name: cookie.name,
    value: cookie.value,
    domain: targetOrigin.hostname,
    path: '/',
    expires: stateExpiry(cookie.expires ?? options.expires),
    httpOnly: true,
    secure: targetOrigin.protocol === 'https:',
    sameSite: 'Lax',
  };
}

/**
 * Strip a browser state down to the session cookies that the app's SSR layer
 * actually consumes.  This deliberately drops localStorage, unrelated
 * cookies, and any source-domain attributes before Playwright receives it.
 */
export function sanitizePasswordlessBrowserState(rawState, targetOrigin) {
  const target =
    targetOrigin instanceof URL
      ? targetOrigin
      : normalizeTargetOrigin(targetOrigin, 'E2E_AUTH_TARGET_ORIGIN_INVALID');
  if (!isRecord(rawState) || !Array.isArray(rawState.cookies)) {
    fail('E2E_AUTH_STATE_INVALID');
  }

  const cookies = rawState.cookies
    .filter(
      (cookie) =>
        isRecord(cookie) && typeof cookie.name === 'string' && AUTH_COOKIE_NAME.test(cookie.name),
    )
    .map((cookie) => canonicalCookie(cookie, target));
  if (cookies.length === 0) fail('E2E_AUTH_STATE_MISSING_SESSION');

  const names = new Set();
  for (const cookie of cookies) {
    if (names.has(cookie.name)) fail('E2E_AUTH_STATE_DUPLICATE_COOKIE');
    names.add(cookie.name);
  }

  return Object.freeze({ cookies: Object.freeze(cookies), origins: Object.freeze([]) });
}

export function resolveE2eTargetOrigin(environment = process.env) {
  const configuredPort = Number(environment.PLAYWRIGHT_PORT ?? 3100);
  const fallback = `http://localhost:${Number.isSafeInteger(configuredPort) ? configuredPort : 3100}`;
  return normalizeTargetOrigin(
    environment.PLAYWRIGHT_BASE_URL ?? environment.NEXT_PUBLIC_SITE_URL ?? fallback,
    'E2E_AUTH_TARGET_ORIGIN_INVALID',
  );
}

function assertSecureRemoteTarget(targetOrigin) {
  if (
    !['localhost', '127.0.0.1'].includes(targetOrigin.hostname) &&
    targetOrigin.protocol !== 'https:'
  ) {
    fail('E2E_AUTH_REMOTE_HTTPS_REQUIRED');
  }
}

function assertLocalSupabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('E2E_AUTH_LOCAL_SUPABASE_CONFIG_INVALID');
  }
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    fail('E2E_AUTH_REMOTE_SESSION_BOOTSTRAP_FORBIDDEN');
  }
  return parsed;
}

function localBootstrapConfig(environment) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !publishableKey || !secretKey) fail('E2E_AUTH_LOCAL_SUPABASE_ENV_MISSING');
  assertLocalSupabaseUrl(url);

  const targetOrigin = resolveE2eTargetOrigin(environment);
  if (!['localhost', '127.0.0.1'].includes(targetOrigin.hostname)) {
    fail('E2E_AUTH_REMOTE_SESSION_BOOTSTRAP_FORBIDDEN');
  }
  return { url, publishableKey, secretKey, targetOrigin };
}

async function waitForCookieWrite(cookieWrite, timeoutMs = 5_000) {
  let timeout;
  try {
    await Promise.race([
      cookieWrite,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function serializeSessionCookies({ url, publishableKey, session }) {
  const writtenCookies = [];
  let resolveWrite;
  const cookieWrite = new Promise((resolve) => {
    resolveWrite = resolve;
  });
  const serverClient = createServerClient(url, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
    cookieOptions: {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    },
    cookies: {
      getAll() {
        return [];
      },
      async setAll(cookies) {
        writtenCookies.splice(0, writtenCookies.length, ...cookies);
        resolveWrite();
      },
    },
  });
  const { error } = await serverClient.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) fail('E2E_AUTH_SESSION_SERIALIZATION_FAILED');
  await waitForCookieWrite(cookieWrite);
  if (writtenCookies.length === 0) fail('E2E_AUTH_SESSION_COOKIE_WRITE_MISSING');
  return writtenCookies;
}

async function createLocalOtpState({ email, config }) {
  const administrator = createClient(config.url, config.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const generated = await administrator.auth.admin.generateLink({ type: 'magiclink', email });
  const emailOtp = generated.data?.properties?.email_otp;
  if (generated.error || typeof emailOtp !== 'string' || !/^\d{6}$/u.test(emailOtp)) {
    fail('E2E_AUTH_OTP_LINK_GENERATION_FAILED');
  }

  const verifier = createClient(config.url, config.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const verified = await verifier.auth.verifyOtp({ email, token: emailOtp, type: 'email' });
  const verifiedEmail = verified.data?.user?.email;
  const session = verified.data?.session;
  if (
    verified.error ||
    typeof verifiedEmail !== 'string' ||
    verifiedEmail.trim().toLowerCase() !== email ||
    !session?.access_token ||
    !session.refresh_token
  ) {
    fail('E2E_AUTH_OTP_SESSION_VERIFICATION_FAILED');
  }

  const cookies = await serializeSessionCookies({
    url: config.url,
    publishableKey: config.publishableKey,
    session,
  });
  return sanitizePasswordlessBrowserState({ cookies }, config.targetOrigin);
}

async function readProvidedState({ source, repositoryRoot, targetOrigin }) {
  if (typeof source !== 'string' || !path.isAbsolute(source)) fail('E2E_AUTH_STATE_PATH_INVALID');
  const resolved = path.resolve(source);
  if (isRepositoryChild(repositoryRoot, resolved)) fail('E2E_AUTH_STATE_REPOSITORY_PATH_FORBIDDEN');

  let content;
  try {
    content = await readFile(resolved, 'utf8');
  } catch {
    fail('E2E_AUTH_STATE_UNREADABLE');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_STORAGE_STATE_BYTES) {
    fail('E2E_AUTH_STATE_TOO_LARGE');
  }
  try {
    return sanitizePasswordlessBrowserState(JSON.parse(content), targetOrigin);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E_AUTH_')) throw error;
    fail('E2E_AUTH_STATE_INVALID');
  }
}

async function writeTemporaryState(directory, role, state) {
  const destination = path.join(directory, `${role}.json`);
  await writeFile(destination, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(destination, 0o600).catch(() => undefined);
  return destination;
}

function stateSensitiveValues(state) {
  return state.cookies.map((cookie) => cookie.value);
}

/**
 * Resolve authenticated Playwright state without adding a browser-visible
 * credential path.  Production/staging callers must supply a state captured
 * after an intentional real-email OTP login.  Only localhost Supabase may
 * mint its disposable states through the Auth magic-link API, which is also
 * the CI path after the fixture identities have been seeded.
 */
export async function prepareReleaseE2eAuth({
  environment = process.env,
  repositoryRoot = process.cwd(),
} = {}) {
  const targetOrigin = resolveE2eTargetOrigin(environment);
  assertSecureRemoteTarget(targetOrigin);
  const adminSource = environment.E2E_ADMIN_STORAGE_STATE;
  const participantSource = environment.E2E_PARTICIPANT_STORAGE_STATE;
  if (Boolean(adminSource) !== Boolean(participantSource)) fail('E2E_AUTH_STATE_PAIR_REQUIRED');

  let adminState;
  let participantState;
  if (adminSource && participantSource) {
    adminState = await readProvidedState({
      source: adminSource,
      repositoryRoot,
      targetOrigin,
    });
    participantState = await readProvidedState({
      source: participantSource,
      repositoryRoot,
      targetOrigin,
    });
  } else {
    const config = localBootstrapConfig(environment);
    const adminEmail = normalizedEmail(environment.E2E_ADMIN_EMAIL, 'E2E_ADMIN_EMAIL_INVALID');
    const participantEmail = normalizedEmail(
      environment.E2E_PARTICIPANT_EMAIL,
      'E2E_PARTICIPANT_EMAIL_INVALID',
    );
    [adminState, participantState] = await Promise.all([
      createLocalOtpState({ email: adminEmail, config }),
      createLocalOtpState({ email: participantEmail, config }),
    ]);
  }

  const directory = await mkdtemp(path.join(tmpdir(), SESSION_STATE_DIRECTORY_PREFIX));
  await chmod(directory, 0o700).catch(() => undefined);
  try {
    const [adminStatePath, participantStatePath] = await Promise.all([
      writeTemporaryState(directory, 'admin', adminState),
      writeTemporaryState(directory, 'participant', participantState),
    ]);
    const sensitiveValues = [
      ...stateSensitiveValues(adminState),
      ...stateSensitiveValues(participantState),
    ];
    return Object.freeze({
      adminStatePath,
      participantStatePath,
      sensitiveValues: Object.freeze(sensitiveValues),
      async cleanup() {
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
}
