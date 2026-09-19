import assert from 'node:assert/strict';
import test from 'node:test';
import { isUprightPng, prepareFacsimilePng } from '../../lib/pdf/facsimile-browser.ts';

/**
 * The browser around `prepareFacsimilePng`, reduced to what it touches: a
 * decoder that reports a size, and canvases that hand back the given pixels
 * and count how often they are asked to encode.
 */
function browser({ width, height, pixels }) {
  const calls = { encoded: 0, closed: 0 };
  const globals = {
    createImageBitmap: async () => ({ width, height, close: () => calls.closed++ }),
    ImageData: class {
      constructor(data, w, h) {
        Object.assign(this, { data, width: w, height: h });
      }
    },
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          putImageData() {},
          getImageData: (_x, _y, w, h) => ({ data: pixels(w, h), width: w, height: h }),
        }),
        toBlob(resolve, type) {
          calls.encoded++;
          resolve(new Blob([new Uint8Array(8)], { type }));
        },
      }),
    },
  };
  const before = Object.fromEntries(Object.keys(globals).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  return { calls, restore: () => Object.assign(globalThis, before) };
}

/** A cut-out: ink in the middle, nothing around it. */
function cutOut(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = Math.abs(x - width / 2) < width / 4 && Math.abs(y - height / 2) < height / 4;
      data.set([30, 60, 170, inside ? 255 : 0], (y * width + x) * 4);
    }
  }
  return data;
}

/** A scanned sheet: opaque paper with a ring of ink on it. */
function scan(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onRing = Math.abs(Math.hypot(x - width / 2, y - height / 2) - height / 3) < 3;
      data.set(onRing ? [70, 100, 190, 255] : [240, 240, 240, 255], (y * width + x) * 4);
    }
  }
  return data;
}

/** One PNG chunk as the container sees it: length, name, that many bytes, a checksum nobody reads here. */
function chunk(name, length) {
  const bytes = new Uint8Array(12 + length);
  new DataView(bytes.buffer).setUint32(0, length);
  bytes.set(
    [...name].map((letter) => letter.charCodeAt(0)),
    4,
  );
  return bytes;
}

/** A PNG container of exactly `size` bytes; what it shows is the fake decoder's business. */
function container(size, { exif = false } = {}) {
  const head = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', 13),
  ];
  if (exif) head.push(chunk('eXIf', 22));
  const taken = head.reduce((sum, part) => sum + part.length, 0) + 12 + 12;
  return [...head, chunk('IDAT', size - taken), chunk('IEND', 0)];
}

const file = (size, type = 'image/png', options) =>
  new File(container(size, options), 'picture', { type });

test('a ready cut-out PNG the server will take is sent as it is, never redrawn', async () => {
  const { calls, restore } = browser({ width: 1600, height: 1200, pixels: cutOut });
  try {
    const original = file(300_000);
    assert.equal(await prepareFacsimilePng(original), original);
    assert.equal(calls.encoded, 0);
    assert.equal(calls.closed, 1);
    // The limit is the routes' own: exactly 2 MiB still goes untouched.
    const atLimit = file(2 * 1024 * 1024);
    assert.equal(await prepareFacsimilePng(atLimit), atLimit);
    assert.equal(calls.encoded, 0);
  } finally {
    restore();
  }
});

test('everything else is still prepared on a canvas, as before', async () => {
  const cases = [
    [
      'a cut-out heavier than the routes read',
      { width: 1600, height: 1200, pixels: cutOut },
      file(2 * 1024 * 1024 + 1),
    ],
    [
      'a cut-out with more pixels than the server decodes',
      { width: 5000, height: 4000, pixels: cutOut },
      file(300_000),
    ],
    [
      'a cut-out that is not a PNG',
      { width: 1600, height: 1200, pixels: cutOut },
      file(300_000, 'image/webp'),
    ],
    ['a scan with its paper still on', { width: 240, height: 180, pixels: scan }, file(300_000)],
    [
      'a cut-out the canvas would turn upright',
      { width: 1600, height: 1200, pixels: cutOut },
      file(300_000, 'image/png', { exif: true }),
    ],
    [
      'a cut-out whose container cannot be followed',
      { width: 1600, height: 1200, pixels: cutOut },
      new File([new Uint8Array(300_000)], 'picture', { type: 'image/png' }),
    ],
  ];
  for (const [name, page, original] of cases) {
    const { calls, restore } = browser(page);
    try {
      const prepared = await prepareFacsimilePng(original);
      assert.notEqual(prepared, original, name);
      assert.equal(prepared.type, 'image/png', name);
      assert.equal(calls.encoded, 1, name);
      assert.equal(calls.closed, 1, name);
    } finally {
      restore();
    }
  }
});

test('a blank sheet and a file of another kind are still refused before anything is sent', async () => {
  const { restore } = browser({
    width: 240,
    height: 180,
    pixels: (w, h) => new Uint8ClampedArray(w * h * 4).fill(238),
  });
  try {
    await assert.rejects(() => prepareFacsimilePng(file(1_000)), /FACSIMILE_EMPTY/u);
    await assert.rejects(() => prepareFacsimilePng(file(1_000, 'image/gif')), /FACSIMILE_TYPE/u);
  } finally {
    restore();
  }
});

test('only a PNG followed to its end without an orientation skips the canvas', async () => {
  const bytes = async (parts) => new Uint8Array(await new Blob(parts).arrayBuffer());
  const plain = await bytes(container(4_000));
  assert.equal(plain.length, 4_000);
  assert.equal(isUprightPng(plain), true);
  // The server does not apply an EXIF orientation; the canvas does.
  assert.equal(isUprightPng(await bytes(container(4_000, { exif: true }))), false);
  // Whatever follows IEND is not part of the picture.
  assert.equal(isUprightPng(await bytes([plain, new Uint8Array(64)])), true);
  assert.equal(isUprightPng(plain.subarray(0, plain.length - 12)), false);
  assert.equal(isUprightPng(plain.subarray(1)), false);
  assert.equal(isUprightPng(new Uint8Array(0)), false);
  // A view into a larger buffer is read from its own start.
  const padded = new Uint8Array(plain.length + 16);
  padded.set(plain, 16);
  assert.equal(isUprightPng(padded.subarray(16)), true);
});
