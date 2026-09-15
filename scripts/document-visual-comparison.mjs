// QA only. Normalize reference/raster density without changing source assets.
import sharp from 'sharp';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const [sourcePath, implementationPath, destination, half] = process.argv.slice(2);
if (!sourcePath || !implementationPath || !destination) throw new Error('source, implementation, output required');
const source = await readFile(sourcePath);
let rendered = sharp(await readFile(implementationPath));
const info = await rendered.metadata();
if (half) rendered = rendered.extract({ left: half === 'right' ? Math.floor(info.width / 2) : 0, top: 0, width: Math.floor(info.width / 2), height: info.height });
const width = half ? 700 : 595, height = half ? 438 : 842;
const reference = await sharp(source).resize(width, height, { fit: 'fill' }).png().toBuffer();
const actual = await rendered.resize(width, height, { fit: 'fill' }).png().toBuffer();
await mkdir(path.dirname(destination), { recursive: true });
await sharp({ create: { width: width * 2 + 16, height, channels: 3, background: '#dddddd' } }).composite([{input: reference,left:0,top:0},{input:actual,left:width+16,top:0}]).png().toFile(destination);
console.log(destination);
