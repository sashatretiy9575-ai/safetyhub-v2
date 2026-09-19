// No `server-only` and no `@/` alias here: the import script normalises a PNG
// with this same function, and plain Node resolves neither.
import sharp from 'sharp';

/** What the browser may send: its own canvas output or a ready cut-out, never a camera original. */
export const FACSIMILE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/**
 * A registered image is a storage object rather than base64 inside the
 * settings row, so it may weigh more than the legacy 400 KB: a stamp with fine
 * lettering then stays 720 px wide instead of dropping to the next size.
 */
export const DOCUMENT_ASSET_MAX_BYTES = 1024 * 1024;
const FACSIMILE_DECODE_PIXELS = 4096 * 4096;
// A stamp is printed about 40 mm wide, so 720 px is over 450 dpi of it. Every
// certificate of a 500-certificate export decodes and deflates the image
// again, which is why it is not kept any larger.
const FACSIMILE_LONG_SIDES = [720, 560, 420] as const;

/**
 * Decodes the whole PNG rather than trusting its header, trims the empty
 * margin and writes one canonical 8-bit RGBA PNG. pdf-lib parses this file in
 * the browser for every certificate; a truncated or exotic PNG stored here
 * would break every download at once. `maxBytes` is what the destination can
 * hold: the largest of the long sides that fits it is the one kept.
 */
export async function normalizeFacsimile(
  bytes: Uint8Array,
  { maxBytes }: { maxBytes: number },
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > FACSIMILE_UPLOAD_MAX_BYTES) {
    throw new Error('FACSIMILE_LIMIT_INVALID');
  }
  try {
    const source = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: FACSIMILE_DECODE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await source.metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) return null;
    if (!metadata.width || !metadata.height || metadata.width < 16 || metadata.height < 16) {
      return null;
    }
    const trimmed = await source
      .ensureAlpha()
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
      .png()
      .toBuffer()
      .catch(() => null);
    // A fully opaque image has no margin to trim; sharp refuses, the source stays.
    const base = trimmed ?? Buffer.from(bytes);
    for (const side of FACSIMILE_LONG_SIDES) {
      const png = await sharp(base, { limitInputPixels: FACSIMILE_DECODE_PIXELS })
        .ensureAlpha()
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      if (png.byteLength <= maxBytes) return new Uint8Array(png);
    }
    return null;
  } catch {
    return null;
  }
}
