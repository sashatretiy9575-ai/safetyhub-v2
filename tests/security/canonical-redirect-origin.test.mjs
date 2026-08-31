import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveSiteOrigin } from '../../lib/site-url.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('production and preview link origins ignore a caller-controlled request host', () => {
  assert.equal(
    resolveSiteOrigin('https://attacker.example', {
      VERCEL_ENV: 'production',
      NEXT_PUBLIC_SITE_URL: 'https://safetyhub.kz',
    }),
    'https://safetyhub.kz',
  );
  assert.equal(
    resolveSiteOrigin('https://attacker.example', {
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'safetyhub-git-a1b2.vercel.app',
    }),
    'https://safetyhub-git-a1b2.vercel.app',
  );
  assert.throws(
    () =>
      resolveSiteOrigin('https://attacker.example', {
        VERCEL_ENV: 'production',
        NEXT_PUBLIC_SITE_URL: 'https://safetyhub-nine.vercel.app',
      }),
    /must equal https:\/\/safetyhub\.kz/u,
  );
});

test('email redirects, invite outbox, PDF QR and callback redirects use only canonical origin', async () => {
  const files = await Promise.all(
    [
      'app/api/admin/users/invite/route.ts',
      'app/api/auth/register/route.ts',
      'app/api/auth/password/recovery/route.ts',
      'app/api/admin/attestations/export/route.ts',
      'app/api/certificates/[certificateId]/route.ts',
      'app/(account)/callback/route.ts',
    ].map(read),
  );
  const adminServer = await read('features/admin/server.ts');
  const proxy = await read('proxy.ts');

  for (const source of files) {
    assert.doesNotMatch(source, /getSiteUrl\([^)]/u);
  }
  assert.doesNotMatch(files.join('\n'), /new URL\([^\n]*url\.origin/u);
  assert.doesNotMatch(files[0], /getSiteUrl|request\.url|url\.origin/u);
  assert.match(adminServer, /export async function inviteUser\(\s*values: InviteUserValues,\s*metadata:/u);
  assert.match(adminServer, /const origin = getSiteUrl\(\)\.replace/u);
  assert.doesNotMatch(adminServer, /requiredString\(operation\.payload, 'redirectOrigin'\)/u);
  assert.match(files[5], /const redirectOrigin = getSiteUrl\(\)/u);
  assert.match(proxy, /new URL\('\/auth\/login', resolveSiteOrigin\(\)\)/u);
  assert.doesNotMatch(proxy, /new URL\('\/auth\/login', request\.url\)/u);
});
