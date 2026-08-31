import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAvatarImageDimensions, parseAvatarImageDimensions } from '../../lib/avatar-image.ts';

function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width, height) {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
}

function webpVp8x(width, height) {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70], 0); // RIFF
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set([87, 69, 66, 80], 8); // WEBP
  bytes.set([86, 80, 56, 88], 12); // VP8X
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const view = new DataView(bytes.buffer);
  view.setUint8(24, (width - 1) & 0xff);
  view.setUint8(25, ((width - 1) >> 8) & 0xff);
  view.setUint8(26, ((width - 1) >> 16) & 0xff);
  view.setUint8(27, (height - 1) & 0xff);
  view.setUint8(28, ((height - 1) >> 8) & 0xff);
  view.setUint8(29, ((height - 1) >> 16) & 0xff);
  return bytes;
}

test('avatar dimensions are parsed from compact JPEG, PNG, and WebP headers', () => {
  assert.deepEqual(parseAvatarImageDimensions(png(360, 480), 'image/png'), {
    width: 360,
    height: 480,
  });
  assert.deepEqual(parseAvatarImageDimensions(jpeg(1920, 1080), 'image/jpeg'), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(parseAvatarImageDimensions(webpVp8x(2048, 1536), 'image/webp'), {
    width: 2048,
    height: 1536,
  });
  assert.equal(parseAvatarImageDimensions(new Uint8Array(24), 'image/png'), null);
});

test('24 megapixels is the inclusive source limit and oversized images fail before decode', () => {
  assert.deepEqual(assertAvatarImageDimensions({ width: 6000, height: 4000 }), {
    width: 6000,
    height: 4000,
  });
  assert.throws(
    () => assertAvatarImageDimensions({ width: 6001, height: 4000 }),
    /AVATAR_SOURCE_TOO_LARGE/,
  );
  assert.throws(
    () => assertAvatarImageDimensions({ width: 0, height: 4000 }),
    /AVATAR_IMAGE_INVALID/,
  );
});
