// Cuts one stamp or signature out of a scan and writes it as a transparent PNG,
// with the same code the document editor runs on an uploaded picture.
//
//   node scripts/build-facsimile-png.mjs <scan> <left,top,width,height> <output.png> [--rotate=<degrees>] [--widen=<factor>]
//
// The result is uploaded in «Документы → Общее» (/admin/documents/common). It is the owner's
// signature: keep it out of this repository, which is public.
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { extractInk } from '../lib/pdf/facsimile-image.ts';

const [scan, box, output, ...flags] = process.argv.slice(2);
const region = (box ?? '').split(',').map(Number);
if (
  !scan ||
  !output ||
  region.length !== 4 ||
  region.some((value) => !Number.isInteger(value) || value < 0)
) {
  throw new Error(
    'Usage: build-facsimile-png.mjs <scan> <left,top,width,height> <output.png> [--rotate=<degrees>] [--widen=<factor>]',
  );
}
const inside = path.relative(process.cwd(), path.resolve(output));
if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
  throw new Error('Write the PNG outside the repository: it must not be committed.');
}
const flag = (name, fallback) =>
  Number(flags.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const rotate = flag('rotate', 0);
// A scanner whose pixels are not square draws a round stamp as an ellipse.
const widen = flag('widen', 1);
const [left, top, width, height] = region;

let source = sharp(scan).extract({ left, top, width, height }).flatten({ background: '#fff' });
if (widen !== 1) {
  source = sharp(await source.png().toBuffer()).resize({
    width: Math.round(width * widen * 2),
    height: height * 2,
    fit: 'fill',
    kernel: 'lanczos3',
  });
}
if (rotate) source = sharp(await source.png().toBuffer()).rotate(rotate, { background: '#fff' });
const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const ink = extractInk({ data, width: info.width, height: info.height });
if (!ink) throw new Error('No ink found in that region.');
await sharp(Buffer.from(ink.data), { raw: { width: ink.width, height: ink.height, channels: 4 } })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(output);
console.log(`${output}: ${ink.width}×${ink.height}`);
