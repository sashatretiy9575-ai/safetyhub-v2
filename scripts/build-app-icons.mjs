/**
 * Draw the PWA / home-screen icons from one SVG in the brand green.
 *
 * The shipped PNGs were a lighter green than the site (`#2aa24f`-ish against
 * the `--color-primary: #176b43` every button uses), so the installed app tile
 * did not look like the site it opened. The icon is the same shield-and-check
 * mark as the header logo (Phosphor `ShieldCheck`), on a solid primary green:
 * ordinary icons with a rounded tile, the maskable one bleeding to the edges
 * with the mark inside the 80 % safe zone.
 *
 * Run with: node scripts/build-app-icons.mjs && node scripts/build-favicon.mjs
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = new URL('../', import.meta.url);
const OUT = (name) => fileURLToPath(new URL(`public/icons/${name}`, ROOT));

// `--color-primary` from app/globals.css (light theme), the green of every
// primary button and the header logo mark.
const PRIMARY = '#176b43';
const PRIMARY_DEEP = '#105936';
const WHITE = '#ffffff';

// Phosphor ShieldCheck (regular), 256-unit viewBox — the header logo glyph.
const SHIELD_CHECK =
  'M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.26,47,25.53a8,8,0,0,0,4.2,0c1-.27,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z';

/**
 * @param {number} size output pixels
 * @param {{ maskable: boolean; square?: boolean }} options
 */
function iconSvg(size, { maskable, square = false }) {
  // Maskable icons are cropped by the launcher (circle, squircle…); the mark
  // must sit inside the central 80 %. Plain icons keep a rounded tile. iOS
  // rounds the touch icon itself and paints transparent corners black, so
  // that one is a full opaque square.
  const glyphScale = maskable ? 0.56 : 0.66;
  const glyph = size * glyphScale;
  const offset = (size - glyph) / 2;
  const radius = maskable || square ? 0 : Math.round(size * 0.2);
  const strokeWidth = (256 / glyph) * (size * 0.012);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${PRIMARY}"/>
      <stop offset="1" stop-color="${PRIMARY_DEEP}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#g)"/>
  <g transform="translate(${offset} ${offset}) scale(${glyph / 256})">
    <path d="${SHIELD_CHECK}" fill="${WHITE}" stroke="${WHITE}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
  </g>
</svg>`;
}

const targets = [
  { name: 'icon-192x192.png', size: 192, maskable: false },
  { name: 'icon-512x512.png', size: 512, maskable: false },
  { name: 'apple-touch-icon.png', size: 180, maskable: false, square: true },
  { name: 'maskable-512x512.png', size: 512, maskable: true },
];

for (const target of targets) {
  const svg = Buffer.from(
    iconSvg(target.size, { maskable: target.maskable, square: target.square === true }),
  );
  const png = await sharp(svg, { density: 384 })
    .resize(target.size, target.size)
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  await writeFile(OUT(target.name), png);
  console.log(
    `Wrote public/icons/${target.name} (${png.byteLength.toLocaleString('en-US')} bytes)`,
  );
}
