export const CONTENT_IMAGE_INPUT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type PreparedContentImage = {
  file: File;
  originalBytes: number;
  preparedBytes: number;
  width: number | null;
  height: number | null;
  converted: boolean;
};

export function scaledImageDimensions(
  width: number,
  height: number,
  maxWidth = 1600,
  maxHeight = 1600,
) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function contentImageOutputName(filename: string) {
  const stem =
    filename
      .replace(/\.[^.]+$/u, '')
      .trim()
      .slice(0, 220) || 'image';
  return `${stem}.webp`;
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob?.type === 'image/webp'
          ? resolve(blob)
          : reject(new Error('CONTENT_IMAGE_WEBP_UNSUPPORTED')),
      'image/webp',
      quality,
    );
  });
}

export async function prepareContentImage(
  source: File,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
): Promise<PreparedContentImage> {
  const fallback: PreparedContentImage = {
    file: source,
    originalBytes: source.size,
    preparedBytes: source.size,
    width: null,
    height: null,
    converted: false,
  };
  if (
    typeof createImageBitmap !== 'function' ||
    typeof document === 'undefined' ||
    !CONTENT_IMAGE_INPUT_TYPES.includes(source.type as (typeof CONTENT_IMAGE_INPUT_TYPES)[number])
  ) {
    return fallback;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    const dimensions = scaledImageDimensions(
      bitmap.width,
      bitmap.height,
      options.maxWidth ?? 1600,
      options.maxHeight ?? 1600,
    );
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) return fallback;
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    const blob = await canvasBlob(canvas, options.quality ?? 0.82);
    const file = new File([blob], contentImageOutputName(source.name), {
      type: 'image/webp',
      lastModified: Date.now(),
    });
    return {
      file,
      originalBytes: source.size,
      preparedBytes: file.size,
      width: dimensions.width,
      height: dimensions.height,
      converted: true,
    };
  } catch {
    return fallback;
  } finally {
    bitmap?.close();
  }
}

export function formatContentImagePreparation(value: PreparedContentImage) {
  const original = Math.max(1, Math.ceil(value.originalBytes / 1024));
  const prepared = Math.max(1, Math.ceil(value.preparedBytes / 1024));
  const dimensions = value.width && value.height ? ` · ${value.width}×${value.height}` : '';
  return value.converted
    ? `Подготовлено: ${original} → ${prepared} КБ${dimensions}, WebP`
    : `Браузер передаст исходный файл: ${prepared} КБ${dimensions}; сервер проверит и преобразует его.`;
}
