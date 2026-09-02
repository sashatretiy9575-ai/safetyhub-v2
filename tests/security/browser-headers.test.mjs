import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContentSecurityPolicy } from '../../lib/security/content-security-policy.ts';
import { THEME_BOOTSTRAP, THEME_BOOTSTRAP_CSP_HASH } from '../../lib/theme.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('sensitive HTML uses an injection-safe nonce policy compatible with Turnstile', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const csp = buildContentSecurityPolicy({ nonce, development: false, strict: true });

  assert.match(csp, new RegExp(`script-src [^;]*'nonce-${nonce}'`));
  assert.match(csp, /script-src [^;]*'strict-dynamic'/u);
  assert.ok(csp.includes(THEME_BOOTSTRAP_CSP_HASH));
  assert.doesNotMatch(csp.match(/script-src [^;]*/u)?.[0] ?? '', /'unsafe-inline'/u);
  assert.match(csp, /script-src-attr 'none'/u);
  assert.doesNotMatch(csp.match(/style-src [^;]*/u)?.[0] ?? '', /'unsafe-inline'/u);
  assert.match(csp, /style-src-attr 'unsafe-inline'/u);
  assert.match(csp, /https:\/\/challenges\.cloudflare\.com/u);
  assert.doesNotMatch(csp, /connect-src [^;]*supabase/u);
  const hostedAvatarCsp = buildContentSecurityPolicy({
    nonce,
    development: false,
    strict: true,
    environment: { NEXT_PUBLIC_SUPABASE_URL: 'https://project-ref.supabase.co' },
  });
  assert.match(
    hostedAvatarCsp,
    /img-src [^;]*https:\/\/project-ref\.supabase\.co\/storage\/v1\/object\/sign\/profile-avatars\//u,
  );
  assert.doesNotMatch(hostedAvatarCsp, /https:\/\/\*\.supabase\.co/u);
  assert.match(csp, /worker-src 'self'/u);
  assert.doesNotMatch(csp.match(/worker-src [^;]*/u)?.[0] ?? '', /blob:/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /object-src 'none'/u);
  assert.match(csp, /base-uri 'self'/u);
  assert.match(csp, /form-action 'self'/u);
  assert.throws(
    () => buildContentSecurityPolicy({ nonce: "bad'; script-src *", strict: true }),
    /CSP_NONCE_INVALID/u,
  );
});

test('the strict CSP hash exactly matches the early theme bootstrap', () => {
  const digest = createHash('sha256').update(THEME_BOOTSTRAP).digest('base64');
  assert.equal(THEME_BOOTSTRAP_CSP_HASH, `'sha256-${digest}'`);
});

test('public CSP remains static while protected routes receive request nonces', async () => {
  const publicCsp = buildContentSecurityPolicy({ development: false, strict: false });
  assert.match(publicCsp, /script-src [^;]*'unsafe-inline'/u);
  assert.doesNotMatch(publicCsp, /'nonce-/u);
  assert.doesNotMatch(publicCsp, /supabase\.co/u);

  const proxy = await read('proxy.ts');
  assert.match(proxy, /const isAuthEntry =[\s\S]*pathname === '\/auth'/u);
  assert.match(proxy, /const needsNonce = isProtected \|\| isAuthEntry/u);
  assert.match(proxy, /requestHeaders\.set\('x-nonce', nonce\)/u);
  assert.match(proxy, /requestHeaders\.set\('Content-Security-Policy', csp\)/u);
  assert.match(proxy, /if \(!isProtected && !isAuthEntry\) \{[\s\S]*NextResponse\.next/u);
  const publicBranch =
    proxy.match(/if \(!isProtected && !isAuthEntry\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.doesNotMatch(publicBranch, /updateSession/u);
});

test('all responses receive baseline browser hardening headers', async () => {
  const config = await read('next.config.ts');
  for (const header of [
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
    'Strict-Transport-Security',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    'Origin-Agent-Cluster',
  ]) {
    assert.match(config, new RegExp(`key: '${header}'`), `${header} is missing`);
  }
  assert.match(config, /source: '\/onboarding\/:path\*'/u);
  assert.match(config, /source: '\/profile\/:path\*'/u);
  assert.match(config, /camera=\(self\)/u);
  assert.match(config, /camera=\(\)/u);
  assert.match(config, /poweredByHeader: false/u);
  assert.match(config, /productionBrowserSourceMaps: false/u);
  assert.match(config, /const privateNoStoreHeaders[\s\S]*private, no-store/u);
  assert.match(config, /source: '\/api\/:path\*'[\s\S]*headers: privateNoStoreHeaders/u);
  assert.match(config, /const privateNoStoreHeaders[\s\S]*Referrer-Policy'[\s\S]*no-referrer/u);
  assert.match(config, /source: '\/callback'[\s\S]*headers: privateNoStoreHeaders/u);
  assert.match(config, /source: '\/auth\/:path\*'[\s\S]*headers: privateNoStoreHeaders/u);
  assert.match(config, /source: '\/verify\/:path\*'[\s\S]*headers: privateNoStoreHeaders/u);
  assert.match(config, /source: '\/sw\.js'[\s\S]*Service-Worker-Allowed/u);
  assert.doesNotMatch(config, /remotePatterns/u);

  const turnstile = await read('features/auth/turnstile.tsx');
  assert.match(turnstile, /nonce=\{nonce\}/u);
  assert.match(turnstile, /useCspNonce\(\)/u);
});
