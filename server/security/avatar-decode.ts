import sharp from 'sharp';

const AVATAR_DECODE_PIXELS = 360 * 360;
const AVATAR_MAX_BYTES = 100 * 1024;
const AVATAR_QUALITIES = [82, 72, 60, 48, 36] as const;
export type AvatarUploadMimeType = 'image/webp' | 'image/jpeg';

async function decodeAvatar(bytes: Uint8Array, mimeType: AvatarUploadMimeType) {
  const image = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: AVATAR_DECODE_PIXELS,
    sequentialRead: true,
  });
  const metadata = await image.metadata();
  const expectedFormat = mimeType === 'image/webp' ? 'webp' : 'jpeg';
  if (
    metadata.format !== expectedFormat ||
    metadata.width !== 360 ||
    metadata.height !== 360 ||
    (metadata.pages ?? 1) !== 1
  ) {
    return null;
  }

  const decoded = await image.raw().toBuffer({ resolveWithObject: true });

  if (
    decoded.info.format !== 'raw' ||
    decoded.info.width !== 360 ||
    decoded.info.height !== 360 ||
    decoded.info.channels < 1 ||
    decoded.info.channels > 4 ||
    decoded.info.size > AVATAR_DECODE_PIXELS * 4
  ) {
    return null;
  }
  return decoded;
}

/**
 * Parses the complete image bitstream, not only its RIFF headers. The decoded
 * allocation is capped to the one accepted avatar canvas, preventing malformed
 * or truncated payloads from being persisted as a supposedly valid photo.
 */
export async function isDecodableAvatarWebp(bytes: Uint8Array) {
  try {
    return (await decodeAvatar(bytes, 'image/webp')) !== null;
  } catch {
    return false;
  }
}

/**
 * Browser canvas encoders are allowed to add metadata even though the source
 * photo was already rasterized. Decode into a bounded raw canvas and encode it
 * again so the stored object has one canonical, metadata-free WebP container.
 * The declared MIME type must match the decoded input format.
 */
export async function normalizeAvatarImage(
  bytes: Uint8Array,
  mimeType: AvatarUploadMimeType,
) {
  try {
    const decoded = await decodeAvatar(bytes, mimeType);
    if (!decoded) return null;

    for (const quality of AVATAR_QUALITIES) {
      const normalized = await sharp(decoded.data, {
        raw: {
          width: decoded.info.width,
          height: decoded.info.height,
          channels: decoded.info.channels,
        },
      })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer();
      if (normalized.byteLength <= AVATAR_MAX_BYTES) return new Uint8Array(normalized);
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeAvatarWebp(bytes: Uint8Array) {
  return normalizeAvatarImage(bytes, 'image/webp');
}
