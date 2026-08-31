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

test('generated links and retired callback redirects use only a canonical origin', async () => {
  const [exportRoute, certificateRoute, callback, retiredHelper] = await Promise.all([
    read('app/api/admin/attestations/export/route.ts'),
    read('app/api/certificates/[certificateId]/route.ts'),
    read('app/(account)/callback/route.ts'),
    read('features/auth/password-auth-retired.tsx'),
  ]);
  const proxy = await read('proxy.ts');

  for (const source of [exportRoute, certificateRoute, callback]) {
    assert.doesNotMatch(source, /getSiteUrl\([^)]/u);
  }
  assert.doesNotMatch([exportRoute, certificateRoute, callback, retiredHelper].join('\n'), /new URL\([^\n]*url\.origin/u);
  assert.match(callback, /redirectFromRetiredPasswordLink\(\)/u);
  assert.match(retiredHelper, /new URL\('\/auth\/login', getSiteUrl\(\)\)/u);
  assert.doesNotMatch(retiredHelper, /request\.url|url\.origin/u);
  assert.match(proxy, /new URL\('\/auth\/login', resolveSiteOrigin\(\)\)/u);
  assert.doesNotMatch(proxy, /new URL\('\/auth\/login', request\.url\)/u);
});
