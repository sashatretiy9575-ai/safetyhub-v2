import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FACSIMILE_TARGET_SIDE,
  extractInk,
  hasTransparency,
} from '../../lib/pdf/facsimile-image.ts';

/** A sheet photographed under a lamp: bright on the left, grey on the right, a ring of ink on it. */
function photographedRing({ width = 240, height = 180, ink = [70, 100, 190] } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const paper = 245 - (x / width) * 60;
      const distance = Math.hypot(x - width / 2, y - height / 2);
      const onRing = Math.abs(distance - 60) < 3;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = onRing ? (ink[c] * paper) / 245 : paper;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const pixel = (image, x, y) => [
  ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];

test('a photographed sheet becomes ink on nothing, cut to the ink and enlarged smoothly', () => {
  const sheet = photographedRing();
  assert.equal(hasTransparency(sheet), false);
  const result = extractInk(sheet);
  assert.ok(result);
  assert.equal(hasTransparency(result), true);
  // Cut to the ring and brought to the stored size; the ring is round, so both sides match.
  assert.equal(Math.max(result.width, result.height), FACSIMILE_TARGET_SIDE);
  assert.ok(Math.abs(result.width - result.height) <= 2);
  // Uneven light is not ink: the centre and the corners are clear on both the lit and the grey side.
  const middle = Math.floor(result.height / 2);
  assert.equal(pixel(result, Math.floor(result.width / 2), middle)[3], 0);
  assert.equal(pixel(result, 1, 1)[3], 0);
  assert.equal(pixel(result, result.width - 2, result.height - 2)[3], 0);
  // The stroke is opaque on the bright side and on the dim side alike.
  const row = Array.from({ length: result.width }, (_, x) => pixel(result, x, middle)[3]);
  assert.ok(Math.max(...row.slice(0, result.width / 2)) > 230);
  assert.ok(Math.max(...row.slice(result.width / 2)) > 230);
  // Blue ink stays blue and is printed deep rather than as pale as the scan.
  const [red, green, blue] = pixel(result, row.indexOf(Math.max(...row)), middle);
  assert.ok(blue > green && green > red, `${red},${green},${blue}`);
  assert.ok(red < 60 && blue > 120, `${red},${green},${blue}`);
});

test('black ink stays black, and a blank sheet is refused rather than stored', () => {
  const black = extractInk(photographedRing({ ink: [40, 40, 40] }));
  assert.ok(black);
  const [red, green, blue] = pixel(black, 0, 0);
  assert.ok(Math.abs(red - green) <= 2 && Math.abs(green - blue) <= 2, `${red},${green},${blue}`);
  const blank = photographedRing();
  for (let i = 0; i < blank.data.length; i += 4) blank.data.fill(238, i, i + 3);
  assert.equal(extractInk(blank), null);
});

test('a picture that already has a cut-out background is recognised and left alone', () => {
  const cutOut = photographedRing();
  for (let i = 3; i < cutOut.data.length; i += 4) cutOut.data[i] = i % 8 === 3 ? 0 : 255;
  assert.equal(hasTransparency(cutOut), true);
});
