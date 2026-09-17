import {
  FACSIMILE_SOURCE_SIDE,
  FACSIMILE_TARGET_SIDE,
  extractInk,
  hasTransparency,
} from './facsimile-image.ts';

export const FACSIMILE_INPUT_TYPES = 'image/png,image/jpeg,image/webp';
const FACSIMILE_INPUT_MAX_BYTES = 20 * 1024 * 1024;

function canvasOf(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('FACSIMILE_CANVAS_UNAVAILABLE');
  return { canvas, context };
}

/**
 * Whatever the administrator picked — a ready cut-out PNG, a scan or a phone
 * photograph of the sheet — becomes the transparent PNG the documents draw.
 */
export async function prepareFacsimilePng(file: File): Promise<Blob> {
  if (!FACSIMILE_INPUT_TYPES.split(',').includes(file.type)) throw new Error('FACSIMILE_TYPE');
  if (file.size > FACSIMILE_INPUT_MAX_BYTES) throw new Error('FACSIMILE_TOO_LARGE');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('FACSIMILE_UNREADABLE');
  });
  try {
    const reduce = Math.min(1, FACSIMILE_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * reduce));
    const height = Math.max(1, Math.round(bitmap.height * reduce));
    const source = canvasOf(width, height);
    source.context.imageSmoothingQuality = 'high';
    source.context.drawImage(bitmap, 0, 0, width, height);
    const pixels = source.context.getImageData(0, 0, width, height);
    let output = source.canvas;
    if (!hasTransparency(pixels)) {
      const ink = extractInk(pixels);
      if (!ink) throw new Error('FACSIMILE_EMPTY');
      const target = canvasOf(ink.width, ink.height);
      target.context.putImageData(
        new ImageData(new Uint8ClampedArray(ink.data), ink.width, ink.height),
        0,
        0,
      );
      output = target.canvas;
    } else if (Math.max(width, height) > FACSIMILE_TARGET_SIDE) {
      const fit = FACSIMILE_TARGET_SIDE / Math.max(width, height);
      const target = canvasOf(Math.round(width * fit), Math.round(height * fit));
      target.context.imageSmoothingQuality = 'high';
      target.context.drawImage(source.canvas, 0, 0, target.canvas.width, target.canvas.height);
      output = target.canvas;
    }
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('FACSIMILE_UNREADABLE');
    return blob;
  } finally {
    bitmap.close();
  }
}
