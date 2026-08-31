import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COURSE_ICONS,
  COURSE_ICON_CATEGORIES,
  isCourseIconId,
  resolveCourseIcon,
  searchCourseIcons,
} from '../../lib/course-icons.ts';
import {
  CONTENT_IMAGE_INPUT_TYPES,
  contentImageOutputName,
  scaledImageDimensions,
} from '../../lib/content-image.ts';

test('course icon registry is broad, categorized, searchable and legacy-compatible', () => {
  assert.ok(COURSE_ICONS.length >= 60);
  assert.equal(COURSE_ICON_CATEGORIES.length, 10);
  assert.equal(new Set(COURSE_ICONS.map((entry) => entry.id)).size, COURSE_ICONS.length);
  for (const id of ['factory', 'shield', 'fire', 'first-aid']) {
    assert.equal(resolveCourseIcon(id).id, id);
    assert.equal(isCourseIconId(id), true);
  }
  assert.equal(isCourseIconId('not-a-real-icon'), false);
  assert.ok(searchCourseIcons('каска', 'Все').some((entry) => entry.id === 'hard-hat'));
  assert.ok(searchCourseIcons('fire', 'Все').some((entry) => entry.id === 'fire'));
  assert.ok(
    searchCourseIcons('', 'Электричество').every((entry) => entry.category === 'Электричество'),
  );
});

test('content image preparation uses bounded dimensions and a canonical WebP name', () => {
  assert.deepEqual(scaledImageDimensions(4000, 2000), { width: 1600, height: 800 });
  assert.deepEqual(scaledImageDimensions(800, 1200), { width: 800, height: 1200 });
  assert.deepEqual(scaledImageDimensions(800, 3200, 1200, 900), {
    width: 225,
    height: 900,
  });
  assert.equal(contentImageOutputName('Фото смены.AVIF'), 'Фото смены.webp');
  assert.deepEqual(CONTENT_IMAGE_INPUT_TYPES, [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
  ]);
});

test('the server decodes uploads with Sharp and rejects spoofed image bytes', async () => {
  const route = await readFile(
    new URL('../../app/api/admin/content-assets/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /sharp\(new Uint8Array/);
  assert.match(route, /limitInputPixels: 40_000_000/);
  assert.match(route, /resolveWithObject: true/);
  assert.match(route, /image\/avif/);
  assert.match(route, /CONTENT_ASSET_DECODE_INVALID/);
  assert.match(route, /\.webp\(/);
  assert.match(route, /createHash\('sha256'\)/);
});
