import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAvatarCanvas } from '../../lib/avatar-image.ts';

function encoderCanvas(resolveType) {
  const calls = [];
  return {
    calls,
    canvas: {
      toBlob(callback, requestedType) {
        calls.push(requestedType);
        const actualType = resolveType(requestedType);
        callback(
          actualType
            ? new Blob([new Uint8Array(1024)], { type: actualType })
            : null,
        );
      },
    },
  };
}

test('avatar encoder prefers a genuine browser WebP result', async () => {
  const fake = encoderCanvas((requestedType) => requestedType);
  const result = await encodeAvatarCanvas(fake.canvas);

  assert.equal(result.type, 'image/webp');
  assert.equal(result.size, 1024);
  assert.equal(fake.calls.includes('image/jpeg'), false);
});

test('avatar encoder falls back to JPEG when a browser ignores WebP output', async () => {
  const fake = encoderCanvas((requestedType) =>
    requestedType === 'image/webp' ? 'image/png' : 'image/jpeg',
  );
  const result = await encodeAvatarCanvas(fake.canvas);

  assert.equal(result.type, 'image/jpeg');
  assert.equal(result.size, 1024);
  assert.ok(fake.calls.indexOf('image/webp') >= 0);
  assert.ok(fake.calls.indexOf('image/jpeg') > fake.calls.indexOf('image/webp'));
});
