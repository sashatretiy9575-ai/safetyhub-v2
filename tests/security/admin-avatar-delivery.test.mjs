import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

const ROUTE = 'app/api/admin/attestations/avatar/[userId]/route.ts';
const HELPER = 'lib/security/api-response.ts';

/**
 * The route and the response facade cannot be imported here (`@/` aliases,
 * `server-only`), so the two pure functions that carry the HTTP semantics are
 * lifted out of the source and run as they are written. Their bodies are plain
 * JavaScript; only the signatures carry types, and those are replaced.
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is defined`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`${name} has no closing brace`);
}

test('the admin avatar is streamed by the route and never leaves as a signed Storage URL', async () => {
  const route = await read(ROUTE);
  assert.doesNotMatch(route, /createSignedUrl/);
  assert.doesNotMatch(route, /redirect\(/);
  assert.doesNotMatch(route, /signedUrl/i);
  assert.match(route, /createPrivateRevalidatedResponse\(/);
  assert.match(route, /@\/lib\/security\/api-response/);
  assert.match(route, /\.from\('profile-avatars'\)\s*\.download\(objectKey/);
  assert.match(route, /'Content-Type': 'image\/webp'/);
  // `server/certificates/photo.ts` imports sharp at module scope, and this
  // route has no outputFileTracingIncludes entry for its native payload.
  assert.doesNotMatch(route, /certificates\/photo|from 'sharp'/);
  // Every miss keeps answering as before.
  assert.match(route, /\{ error: 'AVATAR_NOT_FOUND' \}, \{ status: 404 \}/);
});

test('a conditional request is authorised and ownership-checked before it is answered', async () => {
  const route = await read(ROUTE);
  const handler = route.slice(route.indexOf('export async function GET('));
  const capability = handler.indexOf(
    "await requireAnyCapability(['identity.read', 'identity.manage'])",
  );
  const manifest = handler.indexOf("rpc('get_profile_avatar_manifest'");
  const ownership = handler.indexOf('!isOwnedAvatarObjectKey(');
  const conditional = handler.indexOf("request.headers.get('if-none-match')");
  const notModified = handler.indexOf('avatarNotModified(');
  const download = handler.indexOf('.download(');
  for (const [name, position] of Object.entries({
    capability,
    manifest,
    ownership,
    conditional,
    notModified,
    download,
  })) {
    assert.notEqual(position, -1, `${name} step is present`);
  }
  assert.ok(capability < manifest, 'capability precedes the manifest read');
  assert.ok(manifest < ownership, 'the manifest is read before its key is validated');
  assert.ok(ownership < conditional, 'ownership precedes If-None-Match handling');
  assert.ok(conditional < notModified, 'a 304 is only produced after all of the above');
  assert.ok(ownership < download, 'Storage is only asked for a validated key');
  // Nothing about the request is inspected before the capability check.
  assert.doesNotMatch(handler.slice(0, capability), /request\.headers/);
  // A 304 goes through the same helper, so it carries the same cache policy.
  assert.match(
    route,
    /createPrivateRevalidatedResponse\(null, \{ status: 304, headers: \{ ETag: etag \} \}\)/,
  );
});

test('the validator is the SHA-256 of the bytes that are sent', async () => {
  const route = await read(ROUTE);
  assert.match(route, /sha256: z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\/u\)/);
  assert.match(route, /return `"\$\{sha256\}"`;/);
  assert.match(route, /createHash\('sha256'\)\.update\(new Uint8Array\(body\)\)\.digest\('hex'\)/);
  // Rows imported from before the upload state machine carry a placeholder
  // digest (sixty-four zeros) and a placeholder size (one byte). The manifest
  // may therefore only short-circuit and only be enforced for published rows,
  // and the length always comes from the downloaded bytes.
  assert.match(
    route,
    /if \(!legacyImported && matchesEntityTag\(ifNoneMatch, entityTag\(manifest\.data\.sha256\)\)\)/,
  );
  assert.match(
    route,
    /!legacyImported &&\s*\(body\.byteLength !== manifest\.data\.bytes \|\| sha256 !== manifest\.data\.sha256\)/,
  );
  assert.match(route, /'Content-Length': String\(body\.byteLength\)/);
  assert.doesNotMatch(route, /'Content-Length': String\(manifest/);
  assert.match(route, /body\.byteLength < 1 \|\| body\.byteLength > AVATAR_MAX_BYTES/);
});

test('If-None-Match accepts lists, weak forms and the wildcard, and nothing else', async () => {
  const matchesEntityTag = new Function(
    'header',
    'etag',
    functionBody(await read(ROUTE), 'matchesEntityTag'),
  );
  const etag = `"${'ab'.repeat(32)}"`;
  const other = `"${'cd'.repeat(32)}"`;
  for (const header of [
    etag,
    `W/${etag}`,
    `${other}, ${etag}`,
    `${other} ,  W/${etag}`,
    `  ${etag}  `,
    '*',
  ]) {
    assert.equal(matchesEntityTag(header, etag), true, header);
  }
  for (const header of [
    null,
    '',
    other,
    `W/${other}`,
    etag.slice(1, -1),
    etag.toUpperCase(),
    `w/${etag}`,
    `${other}, ${other}`,
  ]) {
    assert.equal(matchesEntityTag(header, etag), false, String(header));
  }
});

test('the private revalidated response keeps the bytes in one browser and nowhere else', async () => {
  const createPrivateRevalidatedResponse = new Function(
    'body',
    'init',
    functionBody(await read(HELPER), 'createPrivateRevalidatedResponse'),
  );
  const etag = `"${'ab'.repeat(32)}"`;
  const expected = {
    'cache-control': 'private, no-cache, must-revalidate',
    'cdn-cache-control': 'no-store',
    'vercel-cdn-cache-control': 'no-store',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    etag,
  };

  const full = createPrivateRevalidatedResponse(new Uint8Array([1, 2, 3]).buffer, {
    headers: {
      'Content-Type': 'image/webp',
      ETag: etag,
      // A caller cannot loosen the policy.
      'Cache-Control': 'public, max-age=31536000, immutable',
      Vary: 'Accept',
    },
  });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/webp');
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(full.headers.get(name), value, name);
  }
  assert.deepEqual([...new Uint8Array(await full.arrayBuffer())], [1, 2, 3]);

  const notModified = createPrivateRevalidatedResponse(null, {
    status: 304,
    headers: { ETag: etag },
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body, null);
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(notModified.headers.get(name), value, name);
  }

  assert.throws(() => createPrivateRevalidatedResponse(null, { status: 304 }), /require an ETag/);
});
