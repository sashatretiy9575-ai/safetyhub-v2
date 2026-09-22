import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import {
  DOCUMENT_ASSET_MAX_BYTES,
  FACSIMILE_UPLOAD_MAX_BYTES,
  normalizeFacsimile,
} from '../../server/certificates/facsimile-normalize.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const ROUTE = 'app/api/admin/documents/assets/route.ts';
const SERVICE = 'server/certificates/document-assets.ts';
const NORMALIZER = 'server/certificates/facsimile-normalize.ts';
const NEW_FILES = [
  ROUTE,
  SERVICE,
  NORMALIZER,
  'components/admin/documents/facsimile-upload-tile.tsx',
  'components/admin/documents/common-document-form.tsx',
  'tests/client/facsimile-browser.test.mjs',
  'tests/security/document-asset-upload.test.mjs',
];

/** Line breaks and the trailing commas a formatter adds with them say nothing about the order of calls. */
const squeeze = (text) => text.replace(/\s+/gu, '').replace(/,(?=[)\]}])/gu, '');

/** Asserts that the needles appear in the source in this very order. */
function assertOrder(source, needles, message) {
  const text = squeeze(source);
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(squeeze(needle), from);
    assert.ok(at >= 0, `${message}: «${needle}» is missing or out of order`);
    from = at + squeeze(needle).length;
  }
}

test('nobody gets a body read, decoded or stored before origin, capability and both quotas', async () => {
  const [route, rateLimit] = await Promise.all([
    read(ROUTE),
    read('server/security/rate-limit.ts'),
  ]);
  assertOrder(
    route,
    [
      'invalidOriginResponse(request)',
      "await requireCapability('site.settings.manage')",
      "await consumeAdminMutationQuota('site.settings.update', requestSecurityMetadata(request).ipHash)",
      "await consumeBusinessQuota('site.settings.update', actor.user.id)",
      'targetOf(request)',
      "!== 'image/png'",
      'await readBoundedBytes(request, FACSIMILE_UPLOAD_MAX_BYTES)',
      'await registerDocumentAsset({ ...target, bytes })',
    ],
    'the upload route',
  );
  // The service role writes here, so no RPC charges the actor: the route has to,
  // and the policy it names must be one the actor function knows.
  assert.match(rateLimit, /type BusinessQuotaAction =[^;]*\| 'site\.settings\.update';/u);
  // One upload is one unit.
  assert.equal(route.match(/consumeBusinessQuota\(/gu)?.length, 1);
  assert.equal(route.match(/consumeAdminMutationQuota\(/gu)?.length, 1);
  assert.doesNotMatch(await read(SERVICE), /consume(?:Business|AdminMutation|Coarse)Quota/u);

  assert.match(route, /export const runtime = 'nodejs';/u);
  assert.match(route, /export const maxDuration = 60;/u);
  // An image is superseded, never taken away: issued certificates still draw it.
  assert.deepEqual(
    [...route.matchAll(/export (?:async )?function ([A-Z]+)/gu)].map((match) => match[1]),
    ['PUT'],
  );
  assert.match(route, /@\/lib\/security\/api-response/u);
  assert.doesNotMatch(route, /next\/server|\b(?:new Response\s*\(|Response\.json\s*\()/u);
  // A refusal keeps its name; a rate limit answers through the shared handler
  // with Retry-After, exactly as the sibling routes do.
  assert.match(
    route,
    /error instanceof DocumentAssetError[\s\S]*?\{ error: error\.code \}, \{ status: 400 \}/u,
  );
  assert.match(route, /return apiError\(error\);/u);
});

test('an image is stored under its digest and registered to its owner; saving «Общее» binds it', async () => {
  const service = await read(SERVICE);
  assert.match(service, /^import 'server-only';/u);
  const register = service.slice(service.indexOf('export async function registerDocumentAsset'));
  assertOrder(
    register,
    [
      "await requireCapability('site.settings.manage')",
      "(kind === 'stamp' && ownerId !== DOCUMENT_STAMP_OWNER)",
      "new DocumentAssetError('DOCUMENT_ASSET_OWNER_UNKNOWN')",
      'await normalizeFacsimile(bytes, { maxBytes: DOCUMENT_ASSET_MAX_BYTES })',
      "new DocumentAssetError('CERTIFICATE_IMAGE_INVALID')",
      "createHash('sha256').update(png).digest('hex')",
      'await storeFacsimile(client, `${sha256}.png`, png, sha256)',
      'return registerAsset(client, ownerId, kind, sha256)',
    ],
    'registerDocumentAsset',
  );
  // Content-addressed and write-once: a taken name must already hold these bytes.
  assert.match(service, /upsert: false/u);
  assert.doesNotMatch(service, /upsert: true/u);
  assert.match(
    service,
    /if \(digest !== sha256\) throw new Error\('DOCUMENT_ASSET_OBJECT_MISMATCH'\)/u,
  );
  assert.match(service, /object_key: `\$\{sha256\}\.png`/u);
  // The row is found before it is inserted, and a lost race reads the winner's.
  assertOrder(
    service,
    [
      'const known = await find();',
      '.insert({ owner_id: ownerId, kind, sha256,',
      'const raced = await find();',
    ],
    'registerAsset',
  );
  // Nothing is bound here: the commission names its images when «Общее» is
  // saved, and issued certificates are not this module's business at all.
  assert.doesNotMatch(service, /document_profiles|certificates'|document_snapshot|\.rpc\(/u);
});

test('nothing here can take an image away, and no image is committed with the code', async () => {
  for (const file of NEW_FILES) {
    const source = await read(file);
    if (!file.startsWith('tests/')) {
      assert.doesNotMatch(source, /\.remove\(|\.delete\(/u, `${file} must not delete anything`);
    }
    // This repository is public: a signature or a stamp never travels as text.
    assert.doesNotMatch(source, /[A-Za-z0-9+/]{200,}/u, `${file} carries an inline blob`);
  }
});

test('the normaliser is one pipeline with the budget of its destination', async () => {
  const [normalizer, legacy, browser] = await Promise.all([
    read(NORMALIZER),
    read('server/certificates/facsimile-image.ts'),
    read('lib/pdf/facsimile-browser.ts'),
  ]);
  // A Node script imports the pipeline directly; it resolves neither of these.
  assert.doesNotMatch(normalizer, /import 'server-only'|from '@\//u);
  assert.match(legacy, /^import 'server-only';/u);
  assert.match(
    legacy,
    /export \{[^}]*FACSIMILE_UPLOAD_MAX_BYTES[^}]*\} from '\.\/facsimile-normalize\.ts'/u,
  );
  assert.equal(FACSIMILE_UPLOAD_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(DOCUMENT_ASSET_MAX_BYTES, 1024 * 1024);
  // The browser sends a ready cut-out as it is only while the server will take it.
  assert.match(browser, /const FACSIMILE_AS_IS_MAX_BYTES = 2 \* 1024 \* 1024;/u);
  assert.match(browser, /const FACSIMILE_AS_IS_MAX_PIXELS = 4096 \* 4096;/u);
  assert.match(normalizer, /const FACSIMILE_DECODE_PIXELS = 4096 \* 4096;/u);
});

/** A stamp with fine, noisy detail, drawn here: real ones never enter the repository. */
function syntheticStamp(side = 1000) {
  const raw = Buffer.alloc(side * side * 4);
  let state = 7;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      const ring = Math.abs(Math.hypot(x - side / 2, y - side / 2) - side * 0.36) < side * 0.06;
      raw[i] = next() >> 1;
      raw[i + 1] = next() >> 1;
      raw[i + 2] = 128 + (next() >> 1);
      raw[i + 3] = ring ? 128 + (next() >> 1) : 0;
    }
  }
  return sharp(raw, { raw: { width: side, height: side, channels: 4 } });
}

test('a detailed stamp stays 720 px as a registered asset and still fits the legacy row', async () => {
  const source = new Uint8Array(await syntheticStamp().png().toBuffer());
  const [registered, legacy] = await Promise.all([
    normalizeFacsimile(source, { maxBytes: DOCUMENT_ASSET_MAX_BYTES }),
    normalizeFacsimile(source, { maxBytes: 400 * 1024 }),
  ]);
  assert.ok(registered && legacy);
  const [wide, narrow] = await Promise.all([
    sharp(registered).metadata(),
    sharp(legacy).metadata(),
  ]);
  assert.equal(Math.max(wide.width, wide.height), 720);
  assert.ok(
    registered.byteLength > 400 * 1024 && registered.byteLength <= DOCUMENT_ASSET_MAX_BYTES,
  );
  assert.ok(Math.max(narrow.width, narrow.height) < 720);
  assert.ok(legacy.byteLength <= 400 * 1024);
  // Canonical whatever arrived: 8-bit RGBA, not interlaced, margin trimmed.
  for (const meta of [wide, narrow]) {
    assert.deepEqual(
      [meta.format, meta.depth, meta.channels, meta.isProgressive],
      ['png', 'uchar', 4, false],
    );
  }
  const exotic = new Uint8Array(
    await syntheticStamp(400).toColourspace('rgb16').png({ progressive: true }).toBuffer(),
  );
  const canonical = await sharp(
    await normalizeFacsimile(exotic, { maxBytes: DOCUMENT_ASSET_MAX_BYTES }),
  ).metadata();
  assert.deepEqual(
    [canonical.depth, canonical.channels, canonical.isProgressive],
    ['uchar', 4, false],
  );
  assert.ok(canonical.width < 400, 'the transparent margin is cut off');
});

test('what is not a whole PNG is refused, and a budget the bucket cannot hold is a bug', async () => {
  const png = new Uint8Array(await syntheticStamp(64).png().toBuffer());
  const jpeg = new Uint8Array(
    await syntheticStamp(64).flatten({ background: '#fff' }).jpeg().toBuffer(),
  );
  const tiny = new Uint8Array(await syntheticStamp(8).png().toBuffer());
  const budget = { maxBytes: DOCUMENT_ASSET_MAX_BYTES };
  assert.ok(await normalizeFacsimile(png, budget));
  assert.equal(await normalizeFacsimile(jpeg, budget), null);
  assert.equal(await normalizeFacsimile(tiny, budget), null);
  assert.equal(await normalizeFacsimile(png.slice(0, png.length - 40), budget), null);
  assert.equal(await normalizeFacsimile(new Uint8Array(), budget), null);
  // Nothing fits one byte: refused rather than stored oversize.
  assert.equal(await normalizeFacsimile(png, { maxBytes: 1 }), null);
  for (const maxBytes of [0, -1, 1.5, Number.NaN, FACSIMILE_UPLOAD_MAX_BYTES + 1]) {
    await assert.rejects(() => normalizeFacsimile(png, { maxBytes }), /FACSIMILE_LIMIT_INVALID/u);
  }
});
