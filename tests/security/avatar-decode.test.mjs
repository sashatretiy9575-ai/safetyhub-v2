import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { isDecodableAvatarWebp } from '../../lib/security/avatar-decode.ts';
import {
  normalizeAvatarImage,
  normalizeAvatarWebp,
} from '../../lib/security/avatar-decode.ts';
import { validatedStaticWebpDimensions } from '../../lib/security/avatar-webp.ts';

test('avatar decoder accepts a complete 360px WebP and rejects truncated header-only data', async () => {
  const valid = await sharp({
    create: {
      width: 360,
      height: 360,
      channels: 3,
      background: { r: 30, g: 110, b: 70 },
    },
  })
    .webp({ quality: 80 })
    .toBuffer();
  assert.equal(await isDecodableAvatarWebp(valid), true);

  // Structurally plausible VP8L dimensions without a compressed image body.
  const truncated = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f, 0x67, 0x81, 0x59, 1, 0,
  ]);
  assert.equal(await isDecodableAvatarWebp(truncated), false);
});

test('avatar decoder rejects valid WebP canvases outside the fixed allocation', async () => {
  const oversized = await sharp({
    create: {
      width: 361,
      height: 360,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .webp()
    .toBuffer();
  assert.equal(await isDecodableAvatarWebp(oversized), false);
});

test('browser-style ICC WebP is decoded and normalized to the strict storage grammar', async () => {
  const browserCanvas = await sharp({
    create: {
      width: 360,
      height: 360,
      channels: 3,
      background: { r: 30, g: 110, b: 70 },
    },
  })
    .withIccProfile('srgb')
    .webp({ quality: 80 })
    .toBuffer();

  assert.equal(validatedStaticWebpDimensions(browserCanvas), null);
  const normalized = await normalizeAvatarWebp(browserCanvas);
  assert.ok(normalized);
  assert.deepEqual(validatedStaticWebpDimensions(normalized), { width: 360, height: 360 });
  assert.ok(normalized.byteLength <= 100 * 1024);
});

test('a declared JPEG is normalized to canonical WebP and MIME mismatches are rejected', async () => {
  const image = sharp({
    create: {
      width: 360,
      height: 360,
      channels: 3,
      background: { r: 118, g: 71, b: 162 },
    },
  });
  const jpeg = await image.clone().jpeg({ quality: 82 }).toBuffer();
  const png = await image.clone().png().toBuffer();

  const normalized = await normalizeAvatarImage(jpeg, 'image/jpeg');
  assert.ok(normalized);
  assert.deepEqual(validatedStaticWebpDimensions(normalized), { width: 360, height: 360 });
  assert.ok(normalized.byteLength <= 100 * 1024);

  assert.equal(await normalizeAvatarImage(jpeg, 'image/webp'), null);
  assert.equal(await normalizeAvatarImage(png, 'image/jpeg'), null);

  const wrongSize = await sharp({
    create: {
      width: 359,
      height: 360,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();
  assert.equal(await normalizeAvatarImage(wrongSize, 'image/jpeg'), null);
  assert.equal(await normalizeAvatarImage(jpeg.subarray(0, 24), 'image/jpeg'), null);
});
