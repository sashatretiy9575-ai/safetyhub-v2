import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('email-code verification uses the server-authorized role landing instead of a hard-coded profile', async () => {
  const [route, flow, auth] = await Promise.all([
    read('app/api/auth/email-otp/verify/route.ts'),
    read('features/auth/email-otp-flow.tsx'),
    read('features/auth/server.ts'),
  ]);

  assert.match(route, /rpc\('get_auth_context'\)/u);
  assert.match(route, /redirectTo: landingPath\(authContext, locale\)/u);
  assert.match(route, /localizedAccountPath\('\/auth\/legal', locale\)/u);
  assert.match(route, /localizedAccountPath\([\s\S]*?'\/onboarding'[\s\S]*?'\/profile'[\s\S]*?locale/u);
  assert.match(flow, /value === '\/admin'[\s\S]*localizePathname\('\/auth\/legal', locale\)[\s\S]*localizePathname\('\/onboarding', locale\)[\s\S]*localizePathname\('\/profile', locale\)/u);
  assert.match(flow, /router\.replace\(safeLanding\(payload\?\.redirectTo, locale\)\)/u);
  assert.doesNotMatch(flow, /router\.replace\('\/profile'\)/u);
  assert.match(auth, /return role === 'admin' \? '\/admin' : '\/profile'/u);
});

test('retired callback discards legacy links and direct participant workspace routes admins to the console', async () => {
  const [callback, profile] = await Promise.all([
    read('app/(account)/callback/route.ts'),
    read('app/(account)/profile/page.tsx'),
  ]);

  assert.match(callback, /redirectFromRetiredPasswordLink\(\)/u);
  assert.doesNotMatch(callback, /exchangeCodeForSession|verifyOtp|setSession|authenticatedLandingPath/u);
  assert.match(profile, /if \(context\.role === 'admin'\) redirect\('\/admin'\)/u);
});

test('all individual certificate actions use the metadata-and-worker download control', async () => {
  const [download, profile, quiz, admin] = await Promise.all([
    read('features/certificates/download-button.tsx'),
    read('app/(account)/profile/page.tsx'),
    read('components/quiz/quiz-client.tsx'),
    read('components/admin/attestations-manager-panels.tsx'),
  ]);

  assert.match(download, /\/metadata/u);
  assert.match(download, /Accept: 'application\/json'/u);
  assert.match(download, /assertCertificateRenderMetadata/u);
  assert.match(download, /import\('@\/lib\/pdf\/certificate-client'\)/u);
  assert.match(download, /downloadCertificateInBrowser/u);
  assert.doesNotMatch(download, /response\.blob\(\)|application\/pdf|String\.fromCharCode/u);
  for (const source of [profile, quiz, admin]) {
    assert.match(source, /CertificateDownloadButton/u);
    assert.doesNotMatch(source, /href=\{`\/api\/certificates\//u);
  }
});
