import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('auth context is one actor-bound RPC with no browser SDK or MFA branch', async () => {
  const [baseline, auth] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('features/auth/server.ts'),
  ]);

  assert.match(baseline, /create function public\.get_auth_context\(\)/);
  assert.doesNotMatch(baseline, /get_auth_context\([^)]*p_(?:user|actor)_id/);
  assert.match(baseline, /where auth_user\.id = \(select auth\.uid\(\)\)/);
  assert.match(baseline, /auth_user\.deleted_at is null/);
  assert.match(baseline, /auth_user\.banned_until/);
  assert.match(baseline, /join public\.profiles profile/);
  assert.match(baseline, /join public\.user_roles user_role/);
  assert.match(baseline, /join public\.account_controls control/);
  assert.match(baseline, /public\.get_my_capabilities\(\)/);
  assert.match(baseline, /rows 1/);
  assert.doesNotMatch(baseline, /mfa|aal2|totp/i);

  assert.match(auth, /export const getAuthContext = cache\(async/);
  assert.match(auth, /hasSupabaseSessionCookie\(\)/);
  assert.equal((auth.match(/\.rpc\(/g) ?? []).length, 1);
  assert.match(auth, /rpc\('get_auth_context'\)\.maybeSingle\(\)/);
  assert.doesNotMatch(auth, /auth\.getUser|createAdminClient|\.from\(|requiresMfa/);
});

test('profile dashboard returns locale-bound draft, approved identity, legal state, and one best row per revision', async () => {
  const [baseline, localeReads, loader, page] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('supabase/migrations/20260901102000_localized_course_publication_reads.sql'),
    read('features/profile/server.ts'),
    read('app/(account)/profile/page.tsx'),
  ]);

  assert.match(baseline, /create function public\.get_profile_dashboard\(\)/);
  assert.match(baseline, /'profile'/);
  assert.match(baseline, /'approvedIdentity'/);
  assert.match(baseline, /'identityState'/);
  assert.match(baseline, /'legalAcceptances'/);
  assert.match(baseline, /from public\.attestations attestation/);
  assert.doesNotMatch(baseline, /row_number\(\)[\s\S]*test_attempts[\s\S]*get_profile_dashboard/);
  assert.match(localeReads, /create function public\.get_profile_dashboard_locale\(/);
  assert.match(localeReads, /p_locale public\.app_locale/);
  assert.match(localeReads, /public\.get_profile_dashboard\(\)/);
  assert.match(localeReads, /public\.test_revision_localizations/);
  assert.match(localeReads, /revoke all on function public\.get_profile_dashboard_locale/);
  assert.match(localeReads, /grant execute on function public\.get_profile_dashboard_locale/);

  assert.match(loader, /export const getProfileDashboard = cache\(\s*async/);
  assert.match(loader, /rpc\('get_profile_dashboard_locale', \{/);
  assert.match(loader, /p_locale: locale/);
  assert.equal((loader.match(/\.from\(/g) ?? []).length, 1);
  assert.match(loader, /rpc\('get_my_profile_avatar_manifest'\)/);
  assert.match(loader, /isOwnedAvatarObjectKey\(/);
  assert.match(loader, /createSignedUrl\(manifest\.data\.objectKey, 10 \* 60\)/);
  assert.match(page, /Promise\.all\(\[/);
  assert.doesNotMatch(page, /createClient\(|\.from\(['"]/);
  assert.doesNotMatch(page, /attemptCount|attemptsRemaining|history/i);
});

test('public routes take the cookie-free fast path and never prefetch protected data', async () => {
  const proxy = await read('proxy.ts');
  const publicFastPath = proxy.indexOf('if (!isProtected && !isAuthEntry)');
  const refresh = proxy.indexOf('await updateSession');
  assert.ok(publicFastPath > 0 && refresh > publicFastPath);
  assert.equal((proxy.match(/updateSession\(/g) ?? []).length, 1);
  assert.doesNotMatch(proxy, /\.from\('user_roles'\)/);
  assert.match(proxy, /buildContentSecurityPolicy/);
});
