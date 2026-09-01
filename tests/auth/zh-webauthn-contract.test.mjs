import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('zh passkey endpoints are exact, same-origin, bounded, and quota separated', async () => {
  const routes = await Promise.all([
    read('app/api/auth/zh/registration/options/route.ts'),
    read('app/api/auth/zh/registration/verify/route.ts'),
    read('app/api/auth/zh/authentication/options/route.ts'),
    read('app/api/auth/zh/authentication/verify/route.ts'),
    read('app/api/auth/zh/recovery/verify/route.ts'),
    read('app/api/admin/users/[userId]/zh-credential/reset/route.ts'),
  ]);
  for (const route of routes) {
    assert.match(route, /isSameOriginRequest|invalidOriginResponse/u);
    assert.match(route, /readJsonBody/u);
    assert.doesNotMatch(route, /console\.(?:log|error)|syntheticEmail/u);
  }
  assert.match(routes[0], /auth\.zh\.registration\.options/u);
  assert.match(routes[1], /auth\.zh\.registration\.verify/u);
  assert.match(routes[2], /auth\.zh\.authentication\.options/u);
  assert.match(routes[3], /auth\.zh\.authentication\.verify/u);
  assert.match(routes[3], /auth\.zh\.authentication\.credential/u);
  assert.match(routes[4], /auth\.zh\.recovery\.locator/u);
  assert.match(routes[5], /requestSecurityMetadata/u);
});

test('server WebAuthn trust contract requires resident keys, UV, exact RP and one-use receipts', async () => {
  const [server, authServer, config, migration] = await Promise.all([
    read('features/auth/zh-webauthn-server.ts'),
    read('features/auth/server.ts'),
    read('features/auth/zh-webauthn-config.ts'),
    read('supabase/migrations/20260901103000_zh_webauthn_auth.sql'),
  ]);
  assert.match(config, /ZH_WEBAUTHN_PRODUCTION_RP_ID = 'safetyhub\.kz'/u);
  assert.match(config, /ZH_WEBAUTHN_PRODUCTION_ORIGIN = 'https:\/\/safetyhub\.kz'/u);
  assert.match(config, /http:\/\/localhost:3000/u);
  assert.match(config, /http:\/\/127\.0\.0\.1:3000/u);
  assert.match(config, /configuredDevelopmentRelyingParty\(configuredOrigin\)/u);
  assert.match(config, /configuredDevelopment\?\.origin === requestOrigin/u);
  assert.match(config, /url\.protocol !== 'http:'[\s\S]*url\.pathname !== '\/'/u);
  assert.match(server, /residentKey: 'required'/u);
  assert.match(server, /requireResidentKey: true/u);
  assert.match(server, /userVerification: 'required'/u);
  assert.match(server, /requireUserVerification: true/u);
  assert.match(server, /expectedOrigin: relyingParty\.origin/u);
  assert.match(server, /expectedRPID: relyingParty\.rpID/u);
  assert.match(server, /response\.response\.userHandle/u);
  assert.match(server, /signatureCounter/u);
  assert.match(migration, /expires_at <= created_at \+ interval '5 minutes'/u);
  assert.match(migration, /consumed_at is null/u);
  assert.match(migration, /consume_zh_session_grant/u);
  assert.match(migration, /private\.zh_authorized_sessions/u);
  assert.match(migration, /refresh_zh_authorized_session/u);
  assert.match(migration, /safetyhub_zh_epoch/u);
  const epochEnforcement = await read(
    'supabase/migrations/20260901103500_zh_session_epoch_enforcement.sql',
  );
  assert.match(epochEnforcement, /zh_session_epoch_is_current/u);
  assert.match(epochEnforcement, /private\.zh_authorized_sessions/u);
  assert.match(epochEnforcement, /SESSION_REAUTHENTICATION_REQUIRED/u);
  assert.match(epochEnforcement, /and private\.zh_session_epoch_is_current\(auth_user\.id\)/u);
  assert.match(migration, /profile_preferred_locale public\.app_locale/u);
  assert.match(authServer, /preferred_locale: row\.profile_preferred_locale/u);
});

test('synthetic identity and recovery secrets remain server-only', async () => {
  const [server, crypto, migration, client] = await Promise.all([
    read('features/auth/zh-webauthn-server.ts'),
    read('features/auth/zh-webauthn-crypto.ts'),
    read('supabase/migrations/20260901103000_zh_webauthn_auth.sql'),
    read('features/auth/zh-passkey-flow.tsx'),
  ]);
  assert.match(server, /@auth\.invalid/u);
  assert.match(server, /Admin.*generateLink|auth\.admin\.generateLink/su);
  assert.match(server, /verifyOtp/u);
  assert.match(crypto, /ZH_RECOVERY_PEPPER_REQUIRED/u);
  assert.match(crypto, /timingSafeEqual/u);
  assert.match(migration, /private\.zh_recovery_codes/u);
  assert.match(migration, /revoke all on table[\s\S]*private\.zh_webauthn_credentials/u);
  assert.match(migration, /case when private\.is_zh_synthetic_user\(auth_user\.id\)/u);
  assert.match(migration, /jsonb_build_object\('email', '', 'phone', ''\)/u);
  assert.match(migration, /list_admin_access_users_page_provider_internal/u);
  assert.doesNotMatch(
    client,
    /@auth\.invalid|syntheticEmail|SUPABASE_SECRET_KEY|ZH_RECOVERY_PEPPER/u,
  );
  assert.doesNotMatch(client, /localStorage|sessionStorage/u);
});

test('zh client entry has no email, SMS, username, or password credential', async () => {
  const [flow, loginPage, registerPage] = await Promise.all([
    read('features/auth/zh-passkey-flow.tsx'),
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
  ]);
  assert.match(flow, /startAuthentication/u);
  assert.match(flow, /startRegistration/u);
  assert.match(flow, /await import\('@simplewebauthn\/browser'\)/u);
  assert.doesNotMatch(
    flow,
    /^import \{[^\n]*startAuthentication[^\n]*\} from '@simplewebauthn\/browser';/mu,
  );
  assert.match(flow, /recoveryCode/u);
  assert.match(loginPage, /locale === 'zh'.*ZhPasskeyFlow/su);
  assert.match(registerPage, /locale === 'zh'.*ZhPasskeyFlow/su);
  assert.doesNotMatch(flow, /type="password"|name="email"|name="username"|SMS|短信验证码/u);
});
