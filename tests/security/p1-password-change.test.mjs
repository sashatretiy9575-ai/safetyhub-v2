import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

function sqlFunction(source, name) {
  const definition = source.match(
    new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  )?.[0];
  assert.ok(definition, `${name} must exist`);
  return definition;
}

test('password contexts are opaque, session-bound, private, and atomically single-use', async () => {
  const migration = await read('supabase/migrations/20260813000000_safetyhub_baseline.sql');
  const helper = await read('features/auth/password-change.ts');
  const consume = sqlFunction(migration, 'consume_password_change_context');

  assert.match(migration, /create table private\.password_change_contexts/);
  assert.match(migration, /token_hash text primary key/);
  assert.doesNotMatch(migration, /\btoken\s+text\b/);
  assert.match(helper, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(helper, /createHash\('sha256'\)/);
  assert.match(consume, /user_id = p_user_id/);
  assert.match(consume, /session_id = p_session_id/);
  assert.match(consume, /purpose = p_context_kind/);
  assert.match(consume, /consumed_at is null/);
  assert.match(consume, /set consumed_at = statement_timestamp\(\)/);
  assert.match(consume, /return case when found then p_context_kind else null end/);
  assert.match(
    migration,
    /revoke all on all tables in schema private from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant execute on function public\.consume_password_change_context\([^)]+\)[\s\S]*to service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.consume_password_change_context\([^)]+\)\s+to (?:anon|authenticated)/,
  );
});

test('direct update-password navigation cannot expose or execute a password mutation', async () => {
  const page = await read('app/(account)/auth/update-password/page.tsx');
  const route = await read('app/api/auth/password/route.ts');

  assert.doesNotMatch(page, /^'use client'/);
  assert.match(page, /inspectPasswordChangeContext\(/);
  assert.match(page, /passwordContext \? \(/);
  assert.match(page, /<PasswordChangeForm mode=\{passwordContext\.kind\}/);
  assert.match(page, /Обычная активная сессия не подтверждает смену пароля/);
  assert.doesNotMatch(page, /updateUser\(|setSession\(|window\.location/);
  assert.match(route, /consumePasswordChangeContext\(/);
  assert.match(route, /if \(!consumed\)/);
  assert.match(route, /PASSWORD_CONTEXT_INVALID/);
});

test('ordinary password change proves the current password in a fresh non-persisted session', async () => {
  const page = await read('app/(account)/auth/change-password/page.tsx');
  const route = await read('app/api/auth/password/route.ts');
  const helper = await read('features/auth/password-change.ts');

  assert.match(page, /<PasswordChangeForm mode="current"/);
  assert.match(route, /parsed\.data\.currentPassword/);
  assert.match(route, /verifier\.auth\.signInWithPassword\(/);
  assert.match(route, /signIn\.data\.user\?\.id !== context\.user\.id/);
  assert.match(route, /verifier\.auth\.updateUser\(\{[\s\S]*password: parsed\.data\.password,[\s\S]*current_password: parsed\.data\.currentPassword/);
  assert.match(helper, /persistSession: false/);
  assert.match(helper, /autoRefreshToken: false/);
});

test('recovery uses a server-verified email code and a session-bound one-time context', async () => {
  const resetPage = await read('app/(account)/auth/reset-password/page.tsx');
  const [flow, startRoute, verifyRoute, helper, template, config, deployment] = await Promise.all([
    read('features/auth/password-recovery-flow.tsx'),
    read('app/api/auth/password/recovery/route.ts'),
    read('app/api/auth/password/recovery/verify/route.ts'),
    read('features/auth/password-change.ts'),
    read('supabase/templates/recovery.html'),
    read('supabase/config.toml'),
    read('docs/deployment.md'),
  ]);

  assert.match(flow, /clientRequest\('\/api\/auth\/password\/recovery'/);
  assert.match(flow, /clientRequest\('\/api\/auth\/password\/recovery\/verify'/);
  assert.match(flow, /autoComplete="one-time-code"/);
  assert.match(flow, /<PasswordChangeForm mode="recovery"/);
  assert.match(resetPage, /inspectPasswordChangeContext\(/);
  assert.match(resetPage, /context\?\.kind === 'recovery'/);
  assert.match(startRoute, /resetPasswordForEmail\(/);
  assert.doesNotMatch(startRoute, /redirectTo|password_ticket|createPendingRecoveryContext/);
  assert.match(verifyRoute, /verifyOtp\(\{[\s\S]*type: 'recovery'/);
  assert.match(verifyRoute, /createVerifiedRecoveryContext\(user\.id, sessionId\)/);
  assert.match(verifyRoute, /supabase\.auth\.setSession\(/);
  assert.match(verifyRoute, /persistedSessionId !== sessionId/);
  assert.match(verifyRoute, /setPasswordContextCookie\(response, ticket\)/);
  assert.match(verifyRoute, /deletePasswordChangeContext\(ticket\)/);
  assert.match(verifyRoute, /RECOVERY_CODE_INVALID/);
  assert.doesNotMatch(verifyRoute, /access_token:[^\n]*verified: true|refresh_token:[^\n]*verified: true/);
  assert.match(helper, /createVerifiedRecoveryContext\(userId: string, sessionId: string\)/);
  assert.match(helper, /createContext\('recovery', CONTEXT_COOKIE_SECONDS, userId, sessionId\)/);
  assert.match(helper, /sameSite: 'lax'/);
  assert.match(template, /\{\{ \.Token \}\}/);
  assert.doesNotMatch(template, /ConfirmationURL|https?:\/\//);
  assert.match(config, /otp_length = 6/);
  assert.match(config, /otp_expiry = 3600/);
  assert.match(config, /max_frequency = "1m"/);
  assert.match(deployment, /не содержит `\{\{ \.ConfirmationURL \}\}`/);
  assert.match(deployment, /SafetyHub <no-reply@safetyhub\.kz>/);
  assert.match(deployment, /srv-plesk28\.ps\.kz:465/);
});

test('a duplicate mobile-email callback can only resume its exact bound recovery session', async () => {
  const callback = await read('app/(account)/callback/route.ts');

  assert.match(callback, /if \(error && passwordTicket\)/);
  assert.match(callback, /supabase\.auth\.getSession\(\)/);
  assert.match(callback, /inspectPasswordChangeContext\(session\.user\.id, sessionId\)/);
  assert.match(callback, /context\?\.kind === 'recovery'/);
  assert.match(callback, /context\.token === passwordTicket/);
  assert.match(callback, /setPasswordContextCookie\(response, passwordTicket\)/);
});

test('invite fragments cross a validating server bridge and never authorize by query state alone', async () => {
  const admin = await read('features/admin/server.ts');
  const invitePage = await read('app/(account)/auth/invite/page.tsx');
  const contextRoute = await read('app/api/auth/password/context/route.ts');

  assert.match(admin, /newPasswordContextToken\(\)/);
  assert.match(admin, /\/auth\/invite\?ticket=\$\{encodeURIComponent\(passwordTicket\)\}/);
  assert.match(admin, /createPendingInviteContext\(data\.user\.id, passwordTicket\)/);
  assert.match(invitePage, /window\.history\.replaceState\([^;]*'\/auth\/invite'\)/s);
  assert.match(invitePage, /clientRequest\('\/api\/auth\/password\/context'/);
  assert.doesNotMatch(invitePage, /createClient\(|auth\.setSession\(/);
  assert.match(contextRoute, /verifier\.auth\.getUser\(\s*parsed\.data\.accessToken/s);
  assert.match(contextRoute, /verifiedSessionId\(/);
  assert.match(contextRoute, /claimPasswordChangeContext\([\s\S]*'invite'/);
  assert.match(contextRoute, /persistedSessionId !== sessionId/);
  assert.match(contextRoute, /setPasswordContextCookie\(response, parsed\.data\.ticket\)/);
});

test('successful changes revoke other sessions or expose an explicit global sign-out', async () => {
  const route = await read('app/api/auth/password/route.ts');
  const form = await read('features/auth/password-change-form.tsx');
  const logout = await read('app/api/auth/logout/route.ts');

  assert.match(route, /signOut\(\{ scope: 'others' \}\)/);
  assert.match(route, /signOut\(\{ scope: 'global' \}\)/);
  assert.match(route, /sessionsRevoked: false, signedOut: false/);
  assert.match(route, /clearPrivateDeviceState/);
  assert.match(route, /Clear-Site-Data/);
  assert.match(form, /!success\.sessionsRevoked && !success\.signedOut/);
  assert.match(form, /signOutEverywhere/);
  assert.match(form, /clientRequest\('\/api\/auth\/logout'/);
  assert.match(form, /JSON\.stringify\(\{ scope: 'global' \}\)/);
  assert.doesNotMatch(form, /supabase\/client|auth\.signOut/);
  assert.match(logout, /client\.auth\.signOut\(\{ scope \}\)/);
  assert.match(logout, /Clear-Site-Data/);
});
