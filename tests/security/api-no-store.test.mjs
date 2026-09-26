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
      /@\/lib\/security\/api-response|apiError\(|invalidOriginResponse\(|export \{ (?:POST|PATCH|DELETE|GET)(?:, (?:POST|PATCH|DELETE|GET))* \} from '@\/app\/api\//,
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

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute);
      return /\.(?:ts|tsx|mts)$/u.test(entry.name) ? [absolute] : [];
    }),
  );
  return files.flat();
}

test('only the admin avatar route may let a browser keep and revalidate a private response', async () => {
  // The helper is the one way past `no-store` for authenticated data, so its
  // callers are counted across the whole application, not just under app/api:
  // a server module answering on a route's behalf would be the same exception.
  const callers = [];
  for (const directory of ['app', 'components', 'lib', 'server']) {
    for (const file of await sourceFiles(path.join(root, directory))) {
      const source = await readFile(file, 'utf8');
      if (!source.includes('createPrivateRevalidatedResponse')) continue;
      callers.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(callers.sort(), [
    'app/api/admin/attestations/avatar/[userId]/route.ts',
    'lib/security/api-response.ts',
  ]);

  // Revalidation is only as private as the check in front of it: the browser
  // keeps the bytes, so every request — a conditional one included — has to be
  // authorised again, and the validator has to be bound to the content.
  const route = await readFile(
    path.join(root, 'app/api/admin/attestations/avatar/[userId]/route.ts'),
    'utf8',
  );
  assert.match(route, /await requireAnyCapability\(\['identity\.read', 'identity\.manage'\]\)/);
  assert.match(route, /sha256/);
  assert.doesNotMatch(route, /createImmutableAssetResponse|createSignedUrl/);

  // A Windows checkout holds this file with CRLF endings.
  const facade = (
    await readFile(path.join(root, 'lib/security/api-response.ts'), 'utf8')
  ).replaceAll('\r\n', '\n');
  const start = facade.indexOf('export function createPrivateRevalidatedResponse');
  const end = facade.indexOf('\n}\n', start);
  assert.ok(start !== -1 && end > start, 'the helper is defined');
  const helper = facade.slice(start, end);
  assert.match(helper, /if \(!response\.headers\.has\('ETag'\)\) \{\s*throw new Error/);
  assert.match(helper, /'Cache-Control', 'private, no-cache, must-revalidate'/);
  assert.match(helper, /'CDN-Cache-Control', 'no-store'/);
  assert.match(helper, /'Vercel-CDN-Cache-Control', 'no-store'/);
  assert.match(helper, /'Vary', 'Cookie'/);
  assert.match(helper, /'X-Content-Type-Options', 'nosniff'/);
  assert.match(helper, /'Referrer-Policy', 'no-referrer'/);
  // Nothing in it may make the response shareable or fresh without asking.
  assert.doesNotMatch(helper, /public|max-age|s-maxage|immutable|stale-/);
});

test('API response facade disables browser and CDN storage', async () => {
  const source = await readFile(path.join(root, 'lib/security/no-store.ts'), 'utf8');
  assert.match(source, /Cache-Control['"]?: ['"]private, no-store, max-age=0/);
  assert.match(source, /CDN-Cache-Control['"]?: ['"]no-store/);
  assert.match(source, /Vercel-CDN-Cache-Control['"]?: ['"]no-store/);
  assert.match(source, /Pragma: ['"]no-cache/);
  assert.match(source, /Expires: ['"]0/);
});

test('retired Auth callbacks remain behind the no-store response facade', async () => {
  const [callback, retiredHelper] = await Promise.all([
    readFile(path.join(root, 'app/(account)/callback/route.ts'), 'utf8'),
    readFile(path.join(root, 'server/auth/password-auth-retired.ts'), 'utf8'),
  ]);
  assert.match(callback, /redirectFromRetiredPasswordLink\(\)/u);
  assert.match(retiredHelper, /@\/lib\/security\/api-response/u);
  assert.match(retiredHelper, /'Cache-Control', 'no-store'/u);
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
