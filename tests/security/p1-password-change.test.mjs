import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

const legacyPasswordApiRoutes = [
  'app/api/auth/login/route.ts',
  'app/api/auth/register/route.ts',
  'app/api/auth/password/route.ts',
  'app/api/auth/password/context/route.ts',
  'app/api/auth/password/recovery/route.ts',
  'app/api/auth/password/recovery/verify/route.ts',
  'app/api/admin/users/invite/route.ts',
];

const legacyPasswordPages = [
  'app/(account)/auth/change-password/page.tsx',
  'app/(account)/auth/update-password/page.tsx',
  'app/(account)/auth/invite/page.tsx',
];

test('legacy password APIs and pages are removed, so a request is an ordinary 404', async () => {
  for (const route of [...legacyPasswordApiRoutes, ...legacyPasswordPages]) {
    await assert.rejects(read(route), { code: 'ENOENT' }, route);
  }

  const helper = await read('server/auth/password-auth-retired.ts');
  assert.doesNotMatch(helper, /passwordAuthRetiredResponse|PASSWORD_AUTH_RETIRED/u);
});

test('the legacy reset-password page cannot parse a token, render password inputs, or mutate Auth', async () => {
  const sources = await Promise.all(['app/(account)/auth/reset-password/page.tsx'].map(read));

  for (const source of sources) {
    assert.match(source, /PasswordAuthRetiredPage/u);
    assert.doesNotMatch(
      source,
      /'use client'|clientRequest|PasswordChangeForm|PasswordRecoveryFlow|createClient|requireUser|accessToken|refreshToken|type="password"/u,
    );
  }
});

test('legacy callback links discard caller-controlled state without exchanging an Auth code', async () => {
  const [callback, authCallback, helper] = await Promise.all([
    read('app/(account)/callback/route.ts'),
    read('app/(account)/auth/callback/route.ts'),
    read('server/auth/password-auth-retired.ts'),
  ]);

  assert.match(callback, /redirectFromRetiredPasswordLink\(\)/u);
  assert.doesNotMatch(
    callback,
    /exchangeCodeForSession|verifyOtp|setSession|passwordTicket|signupLegal|createClient|new URL\(request\.url\)/u,
  );
  assert.match(authCallback, /export \{ GET \} from '\.\.\/\.\.\/callback\/route'/u);
  assert.match(helper, /new URL\('\/auth\/login', getSiteUrl\(\)\)/u);
  assert.match(helper, /NextResponse\.redirect\([^\n]+, 303\)/u);
  assert.match(helper, /'Referrer-Policy', 'no-referrer'/u);
});

test('obsolete password-entry components are removed from the application bundle', async () => {
  await assert.rejects(read('components/auth/password-change-form.tsx'), { code: 'ENOENT' });
  await assert.rejects(read('components/auth/password-recovery-flow.tsx'), { code: 'ENOENT' });
});
