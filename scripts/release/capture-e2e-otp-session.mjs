import { chromium } from '@playwright/test';
import { chmod, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  resolveE2eTargetOrigin,
  sanitizePasswordlessBrowserState,
} from './e2e-passwordless-session.mjs';

function fail(code) {
  throw new Error(code);
}

function option(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith('--'))
    fail(`E2E_OTP_CAPTURE_${name.slice(2).toUpperCase()}_MISSING`);
  return value;
}

function normalizedEmail(value) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
    fail('E2E_OTP_CAPTURE_EMAIL_INVALID');
  }
  return email;
}

function role(value) {
  if (value !== 'admin' && value !== 'participant') fail('E2E_OTP_CAPTURE_ROLE_INVALID');
  return value;
}

function isRepositoryChild(repositoryRoot, candidate) {
  const relative = path.relative(repositoryRoot, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function outputPath(value) {
  if (!path.isAbsolute(value)) fail('E2E_OTP_CAPTURE_OUTPUT_PATH_INVALID');
  const destination = path.resolve(value);
  if (isRepositoryChild(process.cwd(), destination))
    fail('E2E_OTP_CAPTURE_OUTPUT_REPOSITORY_FORBIDDEN');
  try {
    const parent = await stat(path.dirname(destination));
    if (!parent.isDirectory()) fail('E2E_OTP_CAPTURE_OUTPUT_DIRECTORY_INVALID');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E2E_OTP_CAPTURE_')) throw error;
    fail('E2E_OTP_CAPTURE_OUTPUT_DIRECTORY_INVALID');
  }
  return destination;
}

function expectedWorkspacePath(accountRole) {
  return accountRole === 'admin' ? /\/admin(?:\/|\?|$)/u : /\/profile(?:\?|$)/u;
}

async function saveState(destination, state, replace) {
  await writeFile(destination, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: replace ? 'w' : 'wx',
  });
  await chmod(destination, 0o600).catch(() => undefined);
}

async function main() {
  const email = normalizedEmail(option('--email'));
  const accountRole = role(option('--role'));
  const destination = await outputPath(option('--output'));
  const targetOrigin = resolveE2eTargetOrigin(process.env);
  if (
    !['localhost', '127.0.0.1'].includes(targetOrigin.hostname) &&
    targetOrigin.protocol !== 'https:'
  ) {
    fail('E2E_OTP_CAPTURE_REMOTE_HTTPS_REQUIRED');
  }

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ baseURL: targetOrigin.origin });
    const page = await context.newPage();
    await page.goto('/auth/login', { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await page.getByRole('button', { name: 'Получить код', exact: true }).click();

    // The human operator completes any Turnstile challenge and types the code
    // received through the real configured SMTP route.  This process never
    // reads the mailbox, token, or resulting cookie value into terminal output.
    console.log('E2E_OTP_CAPTURE_WAITING_FOR_INTERACTIVE_LOGIN');
    await page.waitForURL(expectedWorkspacePath(accountRole), { timeout: 15 * 60 * 1_000 });

    const state = sanitizePasswordlessBrowserState(await context.storageState(), targetOrigin);
    await saveState(destination, state, process.argv.includes('--replace'));
    console.log('E2E_OTP_CAPTURED');
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof Error && /^E2E_OTP_CAPTURE_[A-Z_]+$/u.test(error.message)
      ? error.message
      : 'E2E_OTP_CAPTURE_FAILED';
  console.error(code);
  process.exitCode = 1;
}
