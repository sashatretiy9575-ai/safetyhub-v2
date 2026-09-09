/**
 * Build `app/favicon.ico` from the 512 px master icon.
 *
 * `/favicon.ico` was already treated as a real path — `i18n/config.ts` lists it
 * among the paths the proxy must not prefix with a locale — but no such file
 * existed in `app/` or in `public/`, so every request for it (bookmarking,
 * Google's favicon crawler, RSS readers, parts of the Windows and Android
 * shells) rendered the dynamic 404 page instead of returning a static file.
 *
 * Three sizes are packed because a browser tab draws at 16 px and scaling the
 * 192 px PNG down to that is visibly soft.
 *
 * Run with: node scripts/build-favicon.mjs
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = new URL('../', import.meta.url);
const SOURCE = fileURLToPath(new URL('public/icons/icon-512x512.png', ROOT));
const TARGET = fileURLToPath(new URL('app/favicon.ico', ROOT));
const SIZES = [16, 32, 48];

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

const images = await Promise.all(
  SIZES.map((size) =>
    sharp(SOURCE).resize(size, size, { fit: 'contain', kernel: 'lanczos3' }).png().toBuffer(),
  ),
);

const directory = Buffer.alloc(ICONDIR_BYTES + ICONDIRENTRY_BYTES * SIZES.length);
directory.writeUInt16LE(0, 0); // reserved
directory.writeUInt16LE(1, 2); // 1 = icon, 2 = cursor
directory.writeUInt16LE(SIZES.length, 4);

let offset = directory.byteLength;
SIZES.forEach((size, index) => {
  const entry = ICONDIR_BYTES + ICONDIRENTRY_BYTES * index;
  // A 256 px image is written as 0; nothing here is that large, but keep the
  // convention so the file stays valid if a size is added.
  directory.writeUInt8(size % 256, entry);
  directory.writeUInt8(size % 256, entry + 1);
  directory.writeUInt8(0, entry + 2); // palette size, 0 for truecolour
  directory.writeUInt8(0, entry + 3); // reserved
  directory.writeUInt16LE(1, entry + 4); // colour planes
  directory.writeUInt16LE(32, entry + 6); // bits per pixel
  directory.writeUInt32LE(images[index].byteLength, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].byteLength;
});

const icon = Buffer.concat([directory, ...images]);
await writeFile(TARGET, icon);
console.log(`Wrote app/favicon.ico (${icon.byteLength.toLocaleString('en-US')} bytes, ${SIZES.join('/')} px)`);
