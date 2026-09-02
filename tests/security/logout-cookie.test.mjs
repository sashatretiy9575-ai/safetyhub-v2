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
  const [route, menu, signOutAction, cleanup, loginPage, sessionHint] = await Promise.all([
    read('app/api/auth/logout/route.ts'),
    read('components/shared/user-menu.tsx'),
    read('components/shared/sign-out-action.tsx'),
    read('lib/supabase/session-cleanup.ts'),
    read('app/(account)/auth/login/page.tsx'),
    read('lib/supabase/session-hint.ts'),
  ]);

  assert.match(route, /try \{[\s\S]*client\.auth\.signOut\(\{ scope \}\)/u);
  assert.match(route, /scope === 'global' && signOutFailed/u);
  assert.match(route, /clearSafetyHubLocalSession\(request, response\)/u);
  assert.match(cleanup, /request\.cookies\.getAll\(\)/u);
  assert.match(cleanup, /isSupabaseAuthCookieName\(cookie\.name\)/u);
  assert.match(cleanup, /maxAge: 0/u);
  assert.match(cleanup, /safetyhub-password-context/u);
  assert.match(cleanup, /safetyhub-email-otp-challenge/u);
  assert.match(cleanup, /safetyhub-session-hint/u);
  assert.doesNotMatch(cleanup, /password-change/u);
  assert.match(cleanup, /Clear-Site-Data/u);
  assert.match(menu, /<SignOutAction menuItem \/>/u);
  assert.match(signOutAction, /localizePathname\('\/auth\/login', locale\)/u);
  assert.match(signOutAction, /clearSafetyHubDeviceData\(\)/u);
  assert.match(signOutAction, /\?signedOut=1/u);
  assert.match(signOutAction, /role="alert"/u);
  assert.match(loginPage, /query\.signedOut === '1'/u);
  assert.match(loginPage, /languageTranslations\('signedOut'\)/u);
  assert.match(sessionHint, /const SESSION_HINT_MAX_AGE = 400 \* 24 \* 60 \* 60/u);
  assert.match(sessionHint, /maxAge: SESSION_HINT_MAX_AGE/u);
  assert.match(sessionHint, /secure: requestUsesHttps\(request\)/u);
  assert.match(sessionHint, /httpOnly: false/u);
  assert.match(sessionHint, /sameSite: 'lax'/u);
});
