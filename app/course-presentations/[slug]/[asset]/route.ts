import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isContentSlug } from '@/lib/content/slug';

const ASSETS = {
  presentation: { filename: 'presentation.pdf', contentType: 'application/pdf' },
  thumbnail: { filename: 'thumbnail.webp', contentType: 'image/webp' },
} as const;

const MAX_RANGE_BYTES = 2 * 1024 * 1024;

function requestedRange(value: string | null, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Math.min(Number(match[2]), MAX_RANGE_BYTES));
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size) {
    return false;
  }
  const end = Math.min(size - 1, requestedEnd, start + MAX_RANGE_BYTES - 1);
  if (end < start) return false;
  return { start, end };
}

async function serveAsset(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
  headOnly: boolean,
) {
  const { slug, asset } = await context.params;
  if (!isContentSlug(slug) || !(asset in ASSETS)) {
    return new Response('Not found', { status: 404 });
  }
  const descriptor = ASSETS[asset as keyof typeof ASSETS];
  const filePath = path.join(
    process.cwd(),
    'content',
    'snapshots',
    'courses',
    slug,
    descriptor.filename,
  );
  try {
    const metadata = await fs.stat(filePath);
    if (!metadata.isFile()) return new Response('Not found', { status: 404 });
    const size = metadata.size;
    const etag = `W/\"${size}-${Math.trunc(metadata.mtimeMs)}\"`;
    const range = requestedRange(request.headers.get('range'), size);
    if (range === false) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    if (!range && request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': descriptor.contentType,
      'Content-Length': String(range ? range.end - range.start + 1 : size),
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    });
    if (asset === 'presentation' && new URL(request.url).searchParams.has('download')) {
      const filename = `${slug}.pdf`;
      headers.set(
        'Content-Disposition',
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
    }
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    if (headOnly) return new Response(null, { status: range ? 206 : 200, headers });
    const source = createReadStream(filePath, range ? { start: range.start, end: range.end } : {});
    const body = Readable.toWeb(source) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
) {
  return serveAsset(request, context, false);
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
) {
  return serveAsset(request, context, true);
}
