export type WebpDimensions = Readonly<{ width: number; height: number }>;

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function uint32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function sameDimensions(left: WebpDimensions, right: WebpDimensions) {
  return left.width === right.width && left.height === right.height;
}

function chunkDimensions(bytes: Uint8Array, chunk: string, data: number, size: number) {
  if (
    chunk === 'VP8 ' &&
    size >= 10 &&
    bytes[data + 3] === 0x9d &&
    bytes[data + 4] === 0x01 &&
    bytes[data + 5] === 0x2a
  ) {
    return {
      width: (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff,
      height: (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
    const byte1 = bytes[data + 1]!;
    const byte2 = bytes[data + 2]!;
    const byte3 = bytes[data + 3]!;
    const byte4 = bytes[data + 4]!;
    return {
      width: 1 + byte1 + ((byte2 & 0x3f) << 8),
      height: 1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
    };
  }
  return null;
}

/**
 * Validates the complete RIFF container, rejects animation and requires the
 * extended canvas dimensions (when present) to agree with the actual image
 * bitstream. This prevents a tiny forged VP8X header from hiding a very large
 * image from the upload guard.
 */
export function validatedStaticWebpDimensions(bytes: Uint8Array): WebpDimensions | null {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP' ||
    uint32(bytes, 4) !== bytes.length - 8
  ) {
    return null;
  }

  let offset = 12;
  let canvas: WebpDimensions | null = null;
  let image: WebpDimensions | null = null;
  let imageChunks = 0;
  let sawAlpha = false;
  let canvasHasAlpha = false;
  let chunkIndex = 0;

  while (offset + 8 <= bytes.length) {
    const chunk = ascii(bytes, offset, 4);
    const size = uint32(bytes, offset + 4);
    const data = offset + 8;
    const dataEnd = data + size;
    const nextOffset = dataEnd + (size % 2);
    if (dataEnd < data || nextOffset < dataEnd || nextOffset > bytes.length) return null;

    // Avatars are output from our cropper, not a general-purpose WebP upload.
    // Metadata and unknown RIFF chunks could preserve EXIF/XMP/ICC content or
    // hide a polyglot payload, so accept only the minimal static-image grammar.
    if (!['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(chunk)) return null;
    if (chunk === 'VP8X') {
      if (canvas || chunkIndex !== 0 || size !== 10) return null;
      const flags = bytes[data]!;
      // Only alpha is meaningful for our processed avatars. Reject animation,
      // metadata flags and every reserved bit.
      if ((flags & ~0x10) !== 0) return null;
      canvasHasAlpha = (flags & 0x10) !== 0;
      canvas = {
        width: uint24(bytes, data + 4) + 1,
        height: uint24(bytes, data + 7) + 1,
      };
    }

    if (chunk === 'ALPH') {
      if (!canvas || sawAlpha || imageChunks > 0 || size < 2) return null;
      if ((bytes[data]! & 0xc0) !== 0) return null;
      sawAlpha = true;
    }

    const dimensions = chunkDimensions(bytes, chunk, data, size);
    if (dimensions) {
      imageChunks += 1;
      if (imageChunks !== 1) return null;
      if (chunk === 'VP8L' && sawAlpha) return null;
      if (chunk === 'VP8 ' && Boolean(canvas && canvasHasAlpha) !== sawAlpha) {
        return null;
      }
      if (chunk === 'VP8L' && canvasHasAlpha) return null;
      image = dimensions;
    } else if (chunk === 'VP8 ' || chunk === 'VP8L') {
      return null;
    }

    offset = nextOffset;
    chunkIndex += 1;
  }

  if (offset !== bytes.length || !image) return null;
  if (canvas && !sameDimensions(canvas, image)) return null;
  if (canvas && imageChunks !== 1) return null;
  return canvas ?? image;
}
