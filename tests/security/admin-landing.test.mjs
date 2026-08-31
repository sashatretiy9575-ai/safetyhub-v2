import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('password login uses the server-authorized role landing instead of a hard-coded profile', async () => {
  const [route, page, auth] = await Promise.all([
    read('app/api/auth/login/route.ts'),
    read('app/(account)/auth/login/page.tsx'),
    read('features/auth/server.ts'),
  ]);

  assert.match(route, /rpc\('get_auth_context'\)/u);
  assert.match(route, /redirectTo: authenticatedLandingPath\(authContext\.role\)/u);
  assert.match(page, /payload\?\.redirectTo === '\/admin'/u);
  assert.doesNotMatch(page, /router\.replace\('\/profile'\)/u);
  assert.match(auth, /return role === 'admin' \? '\/admin' : '\/profile'/u);
});

test('confirmation callback and direct participant workspace route admins to the console', async () => {
  const [callback, profile] = await Promise.all([
    read('app/(account)/callback/route.ts'),
    read('app/(account)/profile/page.tsx'),
  ]);

  assert.match(callback, /destination = authenticatedLandingPath\(authContext\.role\)/u);
  assert.match(profile, /if \(context\.role === 'admin'\) redirect\('\/admin'\)/u);
});

test('all individual certificate actions use the fetch-and-blob download control', async () => {
  const [download, profile, quiz, admin] = await Promise.all([
    read('features/certificates/download-button.tsx'),
    read('app/(account)/profile/page.tsx'),
    read('components/quiz/quiz-client.tsx'),
    read('components/admin/attestations-manager-panels.tsx'),
  ]);

  assert.match(download, /timeoutMs: 60_000/u);
  assert.match(download, /startsWith\('application\/pdf'\)/u);
  assert.match(download, /String\.fromCharCode\(\.\.\.signature\) === '%PDF-'/u);
  assert.match(download, /document\.body\.append\(link\)/u);
  for (const source of [profile, quiz, admin]) {
    assert.match(source, /CertificateDownloadButton/u);
    assert.doesNotMatch(source, /href=\{`\/api\/certificates\//u);
  }
});
