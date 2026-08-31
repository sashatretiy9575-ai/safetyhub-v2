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

test('legacy password APIs fail closed with an explicit no-store 410 response', async () => {
  const sources = await Promise.all(legacyPasswordApiRoutes.map(read));

  for (const source of sources) {
    assert.match(source, /passwordAuthRetiredResponse\(\)/u);
    assert.doesNotMatch(
      source,
      /signInWithPassword|auth\.signUp|updateUser|resetPasswordForEmail|verifyOtp|inviteUser|createClient|readJsonBody/u,
    );
  }

  const helper = await read('features/auth/password-auth-retired.tsx');
  assert.match(helper, /PASSWORD_AUTH_RETIRED/u);
  assert.match(helper, /status:\s*410/u);
  assert.match(helper, /'Cache-Control': 'no-store'/u);
  assert.match(helper, /'X-Robots-Tag': 'noindex'/u);
});

test('legacy password pages cannot parse a token, render password inputs, or mutate Auth', async () => {
  const sources = await Promise.all(
    [
      'app/(account)/auth/change-password/page.tsx',
      'app/(account)/auth/reset-password/page.tsx',
      'app/(account)/auth/update-password/page.tsx',
      'app/(account)/auth/invite/page.tsx',
    ].map(read),
  );

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
    read('features/auth/password-auth-retired.tsx'),
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
  await assert.rejects(read('features/auth/password-change-form.tsx'), { code: 'ENOENT' });
  await assert.rejects(read('features/auth/password-recovery-flow.tsx'), { code: 'ENOENT' });
});
