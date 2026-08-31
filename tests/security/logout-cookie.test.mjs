import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isSupabaseAuthCookieName } from '../../lib/supabase/auth-cookie-options.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('logout recognizes canonical and chunked Supabase session cookies only', () => {
  assert.equal(isSupabaseAuthCookieName('sb-vezgxdooijznpjqrpvcv-auth-token'), true);
  assert.equal(isSupabaseAuthCookieName('sb-vezgxdooijznpjqrpvcv-auth-token.0'), true);
  assert.equal(isSupabaseAuthCookieName('sb-vezgxdooijznpjqrpvcv-auth-token.12'), true);
  assert.equal(isSupabaseAuthCookieName('sb-project-auth-token-code-verifier'), false);
  assert.equal(isSupabaseAuthCookieName('unrelated-cookie'), false);
});

test('local logout is idempotent while global revocation reports Auth failure', async () => {
  const [route, menu, passwordForm] = await Promise.all([
    read('app/api/auth/logout/route.ts'),
    read('components/shared/user-menu.tsx'),
    read('features/auth/password-change-form.tsx'),
  ]);

  assert.match(route, /try \{[\s\S]*client\.auth\.signOut\(\{ scope \}\)/u);
  assert.match(route, /scope === 'global' && signOutFailed/u);
  assert.match(route, /request\.cookies\.getAll\(\)/u);
  assert.match(route, /isSupabaseAuthCookieName\(cookie\.name\)/u);
  assert.match(route, /maxAge: 0/u);
  assert.match(route, /clearPasswordContextCookie\(response\)/u);
  assert.match(route, /Clear-Site-Data/u);
  assert.match(menu, /window\.location\.replace\('\/auth\/login\?signedOut=1'\)/u);
  assert.match(passwordForm, /window\.location\.replace\('\/auth\/login\?signedOut=1'\)/u);
  assert.match(menu, /role="alert"/u);
});
