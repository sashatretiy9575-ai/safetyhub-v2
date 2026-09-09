import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function apiRouteFiles(directory = path.join(root, 'app', 'api')) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return apiRouteFiles(absolute);
      return entry.name === 'route.ts' ? [absolute] : [];
    }),
  );
  return files.flat();
}

test('every API route uses an explicit cache-policy response boundary', async () => {
  const files = await apiRouteFiles();
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    assert.match(
      source,
      /@\/lib\/security\/api-response|@\/features\/auth\/zh-passkey-retired|apiError\(|invalidOriginResponse\(|export \{ (?:POST|PATCH|DELETE|GET)(?:, (?:POST|PATCH|DELETE|GET))* \} from '@\/app\/api\//,
      `${relative} must return through the shared response boundary`,
    );
    assert.doesNotMatch(
      source,
      /import(?!\s+type\b)[^;]*from ['"]next\/server['"]/,
      `${relative} must not bypass the API response facade`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:new Response\s*\(|Response\.json\s*\()/,
      `${relative} must use createApiResponse for non-JSON bodies`,
    );
  }
});

test('only content-addressed public media may use immutable API caching', async () => {
  const files = await apiRouteFiles();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!source.includes('createImmutableAssetResponse')) continue;
    assert.match(file, /app[\\/]api[\\/]content-assets[\\/]\[assetId\][\\/]route\.ts$/);
    assert.match(source, /\.eq\('status', 'active'\)/);
    assert.match(source, /sha256/);
    assert.doesNotMatch(source, /createServerSupabaseClient|auth\.getUser/);
  }
});

test('API response facade disables browser and CDN storage', async () => {
  const source = await readFile(path.join(root, 'lib/security/no-store.ts'), 'utf8');
  assert.match(source, /Cache-Control['"]?: ['"]private, no-store, max-age=0/);
  assert.match(source, /CDN-Cache-Control['"]?: ['"]no-store/);
  assert.match(source, /Vercel-CDN-Cache-Control['"]?: ['"]no-store/);
  assert.match(source, /Pragma: ['"]no-cache/);
  assert.match(source, /Expires: ['"]0/);
});

test('retired Auth callbacks and ZH WebAuthn tombstones remain behind the no-store response facade', async () => {
  const [callback, retiredHelper, zhRetiredHelper] = await Promise.all([
    readFile(path.join(root, 'app/(account)/callback/route.ts'), 'utf8'),
    readFile(path.join(root, 'features/auth/password-auth-retired.tsx'), 'utf8'),
    readFile(path.join(root, 'features/auth/zh-passkey-retired.ts'), 'utf8'),
  ]);
  assert.match(callback, /redirectFromRetiredPasswordLink\(\)/u);
  assert.match(retiredHelper, /@\/lib\/security\/api-response/u);
  assert.match(retiredHelper, /'Cache-Control', 'no-store'/u);
  assert.match(zhRetiredHelper, /@\/lib\/security\/api-response/u);
  assert.match(zhRetiredHelper, /status: 410/u);
  assert.doesNotMatch(callback, /from ['"]next\/server['"]/);
});

/**
 * `next.config.ts` applies the private cache headers to `/api/:path*`, and the
 * gate above only walks `app/api`. Route handlers that live elsewhere — the
 * licensed course PDF among them — were covered by neither, so a new one could
 * ship with no cache boundary at all and nothing would notice.
 */
async function nonApiRouteFiles(directory = path.join(root, 'app')) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (absolute === path.join(root, 'app', 'api')) return [];
      if (entry.isDirectory()) return nonApiRouteFiles(absolute);
      return entry.name === 'route.ts' ? [absolute] : [];
    }),
  );
  return files.flat();
}

// Handlers whose response is deliberately public and CDN-cacheable. Each entry
// is a decision, not an omission.
const PUBLIC_CACHEABLE_HANDLERS = new Map([
  ['app/manifest/[locale]/route.ts', 'the web app manifest is identical for every visitor'],
  ['app/offline/[locale]/route.ts', 'the offline shell must survive in the service worker cache'],
  [
    'app/certificate-assets/font/route.ts',
    'a content-addressed font served through createImmutableAssetResponse',
  ],
]);

test('route handlers outside app/api declare an explicit cache boundary', async () => {
  const files = await nonApiRouteFiles();
  assert.ok(files.length > 0);

  const seen = new Set();
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    seen.add(relative);
    const source = await readFile(file, 'utf8');
    const reason = PUBLIC_CACHEABLE_HANDLERS.get(relative);
    if (reason) {
      assert.match(
        source,
        /Cache-Control|createImmutableAssetResponse/,
        `${relative} is listed as public (${reason}) but sets no cache policy`,
      );
      continue;
    }
    assert.match(
      source,
      // A re-export inherits the boundary of the handler it forwards to.
      /SENSITIVE_API_CACHE_HEADERS|@\/lib\/security\/api-response|redirectFromRetiredPasswordLink|export \{ [A-Z, ]+ \} from '\.\./,
      `${relative} must route its response through the shared cache boundary`,
    );
  }

  for (const relative of PUBLIC_CACHEABLE_HANDLERS.keys()) {
    assert.ok(seen.has(relative), `${relative} no longer exists; drop it from the allowlist`);
  }
});
