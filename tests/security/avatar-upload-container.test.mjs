import assert from 'node:assert/strict';
import test from 'node:test';
import { validatedStaticWebpDimensions } from '../../lib/security/avatar-webp.ts';

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function ascii(value) {
  return [...value].map((character) => character.charCodeAt(0));
}

function chunk(type, data) {
  return [...ascii(type), ...uint32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}

function dimensions24(value) {
  const stored = value - 1;
  return [stored & 0xff, (stored >>> 8) & 0xff, (stored >>> 16) & 0xff];
}

function vp8l(width, height) {
  const storedWidth = width - 1;
  const storedHeight = height - 1;
  return chunk('VP8L', [
    0x2f,
    storedWidth & 0xff,
    ((storedWidth >>> 8) & 0x3f) | ((storedHeight & 0x03) << 6),
    (storedHeight >>> 2) & 0xff,
    (storedHeight >>> 10) & 0x0f,
  ]);
}

function vp8x(width, height, flags = 0) {
  return chunk('VP8X', [flags, 0, 0, 0, ...dimensions24(width), ...dimensions24(height)]);
}

function webp(...chunks) {
  const payload = [...ascii('WEBP'), ...chunks.flat()];
  return new Uint8Array([...ascii('RIFF'), ...uint32(payload.length), ...payload]);
}

test('avatar WebP validation accepts one consistent static image', () => {
  assert.deepEqual(validatedStaticWebpDimensions(webp(vp8x(360, 360), vp8l(360, 360))), {
    width: 360,
    height: 360,
  });
  assert.deepEqual(validatedStaticWebpDimensions(webp(vp8l(360, 360))), {
    width: 360,
    height: 360,
  });
});

test('forged canvas dimensions, animation and multiple images are rejected', () => {
  assert.equal(validatedStaticWebpDimensions(webp(vp8x(360, 360), vp8l(4096, 4096))), null);
  assert.equal(validatedStaticWebpDimensions(webp(vp8x(360, 360, 0x02), vp8l(360, 360))), null);
  assert.equal(validatedStaticWebpDimensions(webp(vp8l(360, 360), vp8l(360, 360))), null);
});

test('trailing polyglot bytes and a forged RIFF size are rejected', () => {
  const valid = webp(vp8l(360, 360));
  assert.equal(
    validatedStaticWebpDimensions(new Uint8Array([...valid, ...ascii('<script>')])),
    null,
  );
  const forged = valid.slice();
  forged[4] = 0;
  assert.equal(validatedStaticWebpDimensions(forged), null);
});

test('metadata, unknown chunks, inconsistent alpha flags and invalid ordering are rejected', () => {
  const metadata = ascii('camera make and GPS');
  for (const type of ['EXIF', 'XMP ', 'ICCP', 'JUNK']) {
    assert.equal(
      validatedStaticWebpDimensions(webp(vp8x(360, 360), chunk(type, metadata), vp8l(360, 360))),
      null,
    );
  }
  assert.equal(validatedStaticWebpDimensions(webp(vp8l(360, 360), vp8x(360, 360))), null);
  assert.equal(validatedStaticWebpDimensions(webp(vp8x(360, 360, 0x10), vp8l(360, 360))), null);
  assert.equal(
    validatedStaticWebpDimensions(
      webp(vp8x(360, 360, 0x10), chunk('ALPH', [0, 0]), vp8l(360, 360)),
    ),
    null,
  );
  assert.equal(validatedStaticWebpDimensions(webp(chunk('ALPH', [0, 0]), vp8l(360, 360))), null);
});

test('avatar route rejects ambiguous request framing and durably cancels without racing removal', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../../app/api/profile/avatar/route.ts', import.meta.url), 'utf8'),
  );
  assert.match(source, /\^\(\?:0\|\[1-9\]\\d\*\)\$/);
  assert.match(source, /Number\.isSafeInteger\(contentLength\)/);
  assert.match(source, /\{1,70\}/);
  assert.doesNotMatch(source, /boundary=\/iu/);
  assert.match(source, /cacheControl: '600'/);
  assert.doesNotMatch(source, /cacheControl: '31536000'/);
  assert.match(source, /createSignedUrl\(committed\.objectKey, 10 \* 60\)/);
  assert.match(source, /abort_profile_avatar_upload/);
  assert.match(
    source,
    /abortResult\.status !== 'cancel_requested' \|\| abortResult\.objectKey !== objectKey/u,
  );
  const compensation = source.slice(
    source.indexOf('async function abortPrecommitOperation'),
    source.indexOf('async function markUploadLeaseFinished'),
  );
  assert.match(compensation, /'abort_profile_avatar_upload'/u);
  assert.doesNotMatch(compensation, /\.remove\(/u);
  assert.doesNotMatch(source, /remove\(\[committed\.objectKey\]\)|mark_profile_avatar_uploaded/u);
});
