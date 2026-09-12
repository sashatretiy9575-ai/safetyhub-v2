export const AVATAR_MAX_BYTES = 100 * 1024;
export const AVATAR_TARGET_BYTES = 50 * 1024;
export const AVATAR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const AVATAR_SOURCE_MAX_PIXELS = 24_000_000;
export const AVATAR_WIDTH = 360;
export const AVATAR_HEIGHT = 360;
export const AVATAR_MIN_ZOOM = 1;
export const AVATAR_MAX_ZOOM = 3;

const MIN_QUALITY = 0.2;
const MAX_QUALITY = 0.86;
const QUALITY_STEPS = 9;
const SOURCE_HEADER_INITIAL_BYTES = 64 * 1024;
const SOURCE_HEADER_MAX_BYTES = 1024 * 1024;
const ALLOWED_SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AVATAR_OUTPUT_TYPES = ['image/webp', 'image/jpeg'] as const;

export type AvatarImageDimensions = Readonly<{ width: number; height: number }>;

export type AvatarCrop = Readonly<{
  zoom: number;
  offsetX: number;
  offsetY: number;
}>;

export const DEFAULT_AVATAR_CROP: AvatarCrop = {
  zoom: AVATAR_MIN_ZOOM,
  offsetX: 0,
  offsetY: 0,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function validateAvatarSource(file: File) {
  if (!ALLOWED_SOURCE_TYPES.has(file.type)) throw new Error('AVATAR_IMAGE_REQUIRED');
  if (file.size <= 0) throw new Error('AVATAR_IMAGE_INVALID');
  if (file.size > AVATAR_SOURCE_MAX_BYTES) throw new Error('AVATAR_SOURCE_TOO_LARGE');
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset]! * 256 + bytes[offset + 1]!;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset]! + bytes[offset + 1]! * 256;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! * 16_777_216 +
    bytes[offset + 1]! * 65_536 +
    bytes[offset + 2]! * 256 +
    bytes[offset + 3]!
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 256 +
    bytes[offset + 2]! * 65_536 +
    bytes[offset + 3]! * 16_777_216
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function parsePngDimensions(bytes: Uint8Array): AvatarImageDimensions | null {
  if (bytes.length < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
  };
}

function isJpegStartOfFrame(marker: number) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpegDimensions(bytes: Uint8Array): AvatarImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;

  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2) return null;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7 || offset + 7 > bytes.length) return null;
      return {
        height: readUint16BigEndian(bytes, offset + 3),
        width: readUint16BigEndian(bytes, offset + 5),
      };
    }

    if (offset + segmentLength > bytes.length) return null;
    offset += segmentLength;
  }

  return null;
}

function parseWebpDimensions(bytes: Uint8Array): AvatarImageDimensions | null {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = readUint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;

    if (chunkType === 'VP8X') {
      if (chunkLength < 10 || dataOffset + 10 > bytes.length) return null;
      return {
        width: readUint24LittleEndian(bytes, dataOffset + 4) + 1,
        height: readUint24LittleEndian(bytes, dataOffset + 7) + 1,
      };
    }

    if (chunkType === 'VP8L') {
      if (chunkLength < 5 || dataOffset + 5 > bytes.length || bytes[dataOffset] !== 0x2f) {
        return null;
      }
      const byte1 = bytes[dataOffset + 1]!;
      const byte2 = bytes[dataOffset + 2]!;
      const byte3 = bytes[dataOffset + 3]!;
      const byte4 = bytes[dataOffset + 4]!;
      return {
        width: 1 + byte1 + ((byte2 & 0x3f) << 8),
        height: 1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
      };
    }

    if (chunkType === 'VP8 ') {
      if (
        chunkLength < 10 ||
        dataOffset + 10 > bytes.length ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        return null;
      }
      return {
        width: readUint16LittleEndian(bytes, dataOffset + 6) & 0x3fff,
        height: readUint16LittleEndian(bytes, dataOffset + 8) & 0x3fff,
      };
    }

    const nextOffset = dataOffset + chunkLength + (chunkLength % 2);
    if (nextOffset > bytes.length || nextOffset <= offset) return null;
    offset = nextOffset;
  }

  return null;
}

export function parseAvatarImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): AvatarImageDimensions | null {
  if (mimeType === 'image/png') return parsePngDimensions(bytes);
  if (mimeType === 'image/jpeg') return parseJpegDimensions(bytes);
  if (mimeType === 'image/webp') return parseWebpDimensions(bytes);
  return null;
}

export function assertAvatarImageDimensions(
  dimensions: AvatarImageDimensions | null,
): AvatarImageDimensions {
  if (
    !dimensions ||
    !Number.isInteger(dimensions.width) ||
    !Number.isInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new Error('AVATAR_IMAGE_INVALID');
  }
  if (dimensions.width > Math.floor(AVATAR_SOURCE_MAX_PIXELS / dimensions.height)) {
    throw new Error('AVATAR_SOURCE_TOO_LARGE');
  }
  return dimensions;
}

export async function validateAvatarSourceDimensions(file: File) {
  validateAvatarSource(file);
  const maximumHeaderBytes = Math.min(file.size, SOURCE_HEADER_MAX_BYTES);
  let headerBytes = Math.min(maximumHeaderBytes, SOURCE_HEADER_INITIAL_BYTES);

  while (headerBytes > 0) {
    const bytes = new Uint8Array(await file.slice(0, headerBytes).arrayBuffer());
    const dimensions = parseAvatarImageDimensions(bytes, file.type);
    if (dimensions) return assertAvatarImageDimensions(dimensions);
    if (headerBytes === maximumHeaderBytes) break;
    headerBytes = Math.min(maximumHeaderBytes, headerBytes * 2);
  }

  throw new Error('AVATAR_IMAGE_INVALID');
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: (typeof AVATAR_OUTPUT_TYPES)[number],
  quality: number,
) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob?.type === mimeType ? blob : null),
      mimeType,
      quality,
    );
  });
}

export async function loadAvatarImage(file: File) {
  await validateAvatarSourceDimensions(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        assertAvatarImageDimensions({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      } catch (error) {
        reject(error);
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('AVATAR_IMAGE_INVALID'));
    };
    image.src = objectUrl;
  });
}

function sourceCrop(image: HTMLImageElement, crop: AvatarCrop) {
  const targetRatio = AVATAR_WIDTH / AVATAR_HEIGHT;
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const baseWidth =
    sourceRatio > targetRatio ? image.naturalHeight * targetRatio : image.naturalWidth;
  const baseHeight =
    sourceRatio > targetRatio ? image.naturalHeight : image.naturalWidth / targetRatio;
  const zoom = clamp(crop.zoom, AVATAR_MIN_ZOOM, AVATAR_MAX_ZOOM);
  const width = baseWidth / zoom;
  const height = baseHeight / zoom;
  const x =
    (image.naturalWidth - width) / 2 +
    clamp(crop.offsetX, -1, 1) * ((image.naturalWidth - width) / 2);
  const y =
    (image.naturalHeight - height) / 2 +
    clamp(crop.offsetY, -1, 1) * ((image.naturalHeight - height) / 2);
  return { x, y, width, height };
}

export function drawAvatarCrop(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  crop: AvatarCrop,
  width = AVATAR_WIDTH,
  height = AVATAR_HEIGHT,
) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('AVATAR_CANVAS_UNAVAILABLE');
  const source = sourceCrop(image, crop);
  canvas.width = width;
  canvas.height = height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, width, height);
  context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height);
}

async function bestBlobWithinLimit(
  canvas: HTMLCanvasElement,
  maximumBytes: number,
  mimeType: (typeof AVATAR_OUTPUT_TYPES)[number],
) {
  let low = MIN_QUALITY;
  let high = MAX_QUALITY;
  let best = await canvasToBlob(canvas, mimeType, low);
  if (!best) return null;
  if (best.size > maximumBytes) return null;

  for (let step = 0; step < QUALITY_STEPS; step += 1) {
    const quality = (low + high) / 2;
    const candidate = await canvasToBlob(canvas, mimeType, quality);
    if (!candidate) return best;
    if (candidate.size <= maximumBytes) {
      best = candidate;
      low = quality;
    } else {
      high = quality;
    }
  }
  return best;
}

export async function compressAvatar(
  file: File,
  crop: AvatarCrop = DEFAULT_AVATAR_CROP,
): Promise<Blob> {
  validateAvatarSource(file);
  const image = await loadAvatarImage(file);
  const canvas = document.createElement('canvas');
  drawAvatarCrop(image, canvas, crop);

  return encodeAvatarCanvas(canvas);
}

export async function encodeAvatarCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const mimeType of AVATAR_OUTPUT_TYPES) {
    const targetAvatar = await bestBlobWithinLimit(canvas, AVATAR_TARGET_BYTES, mimeType);
    if (targetAvatar) return targetAvatar;

    const maximumAvatar = await bestBlobWithinLimit(canvas, AVATAR_MAX_BYTES, mimeType);
    if (maximumAvatar) return maximumAvatar;
  }

  throw new Error('AVATAR_TOO_COMPLEX');
}
