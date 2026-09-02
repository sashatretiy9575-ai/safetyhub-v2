import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { authRealmForLocale, localeMatchesAuthRealm } from '../../i18n/config.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('locale contract uses the two fixed auth realms', () => {
  for (const locale of ['ru', 'kk', 'en']) {
    assert.equal(authRealmForLocale(locale), 'email_otp');
    assert.equal(localeMatchesAuthRealm(locale, 'email_otp'), true);
    assert.equal(localeMatchesAuthRealm(locale, 'zh_username_password'), false);
  }
  assert.equal(authRealmForLocale('zh'), 'zh_username_password');
  assert.equal(localeMatchesAuthRealm('zh', 'zh_username_password'), true);
  assert.equal(localeMatchesAuthRealm('zh', 'email_otp'), false);
});

test('middleware derives only a non-authoritative realm hint from signed user metadata', async () => {
  const middleware = await read('lib/supabase/middleware.ts');
  assert.match(middleware, /export function authRealmForSessionUser/u);
  assert.match(middleware, /safetyhub_auth_kind[\s\S]*zh_username_password/u);
  assert.match(middleware, /unexpected credential marker/u);
  assert.match(middleware, /return null/u);
  assert.match(middleware, /return 'email_otp'/u);
  assert.match(middleware, /private\.assert_locale_matches_auth_realm/u);
});

test('realm transitions have a single server-authorized write and local cleanup', async () => {
  const [endpoint, cleanup, logout] = await Promise.all([
    read('app/api/profile/locale/route.ts'),
    read('lib/supabase/session-cleanup.ts'),
    read('app/api/auth/logout/route.ts'),
  ]);

  assert.match(endpoint, /state: 'updated'/u);
  assert.match(endpoint, /state: 'signed_out'/u);
  assert.match(endpoint, /set_preferred_locale/u);
  assert.match(endpoint, /AUTH_REALM_LOCALE_MISMATCH/u);
  assert.match(endpoint, /clearSafetyHubLocalSession/u);
  assert.doesNotMatch(endpoint, /supabase\.auth\.updateUser/u);

  assert.match(cleanup, /isSupabaseAuthCookieName/u);
  assert.match(cleanup, /safetyhub-email-otp-challenge/u);
  assert.match(cleanup, /safetyhub-session-hint/u);
  assert.match(cleanup, /'"cache", "storage"'/u);
  assert.doesNotMatch(cleanup, /headers\.set\('Clear-Site-Data',\s*'"cookies"'\)/u);
  assert.match(logout, /clearSafetyHubLocalSession\(request, response\)/u);
});

test('protected/auth-entry route defense is realm-aware without authenticating public GETs', async () => {
  const proxy = await read('proxy.ts');
  assert.match(proxy, /const isAuthEntry =[\s\S]*pathname === '\/auth'/u);
  assert.match(proxy, /if \(!isProtected && !isAuthEntry\)/u);
  assert.match(proxy, /authRealmForSessionUser\(user\) !== authRealmForLocale\(locale\)/u);
  assert.match(proxy, /clearSafetyHubLocalSession/u);
  const publicBranch =
    proxy.match(/if \(!isProtected && !isAuthEntry\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.doesNotMatch(publicBranch, /updateSession/u);
});

test('the forward-only SQL boundary covers preferences, localized reads and immutable attempts', async () => {
  const migration = await read('supabase/migrations/20260902170000_auth_realm_locale_boundary.sql');
  for (const procedure of [
    'private.assert_locale_matches_auth_realm',
    'public.set_preferred_locale',
    'public.get_profile_dashboard_locale',
    'public.get_approved_course_presentation_locale',
    'public.start_test_attempt_locale',
    'public.get_test_attempt',
    'public.complete_test_attempt',
  ]) {
    assert.match(migration, new RegExp(procedure.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(migration, /private\.zh_username_accounts/u);
  assert.match(migration, /safetyhub_auth_kind/u);
  assert.match(migration, /AUTH_REALM_LOCALE_MISMATCH/u);
  assert.match(migration, /auth realm locale normalization candidates/u);
  assert.match(migration, /auth realm locale normalization remaining/u);
  assert.match(migration, /set preferred_locale = 'zh'/u);
  assert.match(migration, /set preferred_locale = 'ru'/u);
  assert.match(migration, /revoke all on function private\.assert_locale_matches_auth_realm/u);
});
