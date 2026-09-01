import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApiResponse, createImmutableAssetResponse } from '@/lib/security/api-response';
import { hasExactCanonicalSearch } from '@/lib/security/canonical-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LATIN_FONT_PATH = path.join(
  process.cwd(),
  'lib',
  'pdf',
  'assets',
  'noto-sans-latin-cyrillic.ttf',
);
const CJK_FONT_PATH = path.join(
  process.cwd(),
  'lib',
  'pdf',
  'assets',
  'NotoSansCJKsc-Regular-Sans2.004.otf',
);
const CJK_FONT_BYTES = 16_437_364;
const CJK_FONT_ETAG = '"2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"';

type FontDescriptor = {
  locale: 'ru' | 'kk' | 'en' | 'zh';
  path: string;
  contentType: 'font/ttf' | 'font/otf';
  expectedBytes?: number;
  etag: string;
};

const FONT_REQUESTS = new Map<string, FontDescriptor>([
  [
    '?locale=ru&v=1',
    {
      locale: 'ru',
      path: LATIN_FONT_PATH,
      contentType: 'font/ttf',
      etag: '"noto-sans-latin-cyrillic-v1"',
    },
  ],
  [
    '?locale=kk&v=1',
    {
      locale: 'kk',
      path: LATIN_FONT_PATH,
      contentType: 'font/ttf',
      etag: '"noto-sans-latin-cyrillic-v1"',
    },
  ],
  [
    '?locale=en&v=1',
    {
      locale: 'en',
      path: LATIN_FONT_PATH,
      contentType: 'font/ttf',
      etag: '"noto-sans-latin-cyrillic-v1"',
    },
  ],
  [
    '?locale=zh&v=Sans2.004',
    {
      locale: 'zh',
      path: CJK_FONT_PATH,
      contentType: 'font/otf',
      expectedBytes: CJK_FONT_BYTES,
      etag: CJK_FONT_ETAG,
    },
  ],
]);

const fontReads = new Map<string, Promise<Buffer>>();

function readFont(descriptor: FontDescriptor) {
  let pending = fontReads.get(descriptor.path);
  if (!pending) {
    pending = fs.readFile(descriptor.path);
    fontReads.set(descriptor.path, pending);
  }
  return pending;
}

export async function GET(request: Request) {
  const canonicalSearch = [...FONT_REQUESTS.keys()].find((candidate) =>
    hasExactCanonicalSearch(request.url, candidate),
  );
  const descriptor = canonicalSearch ? FONT_REQUESTS.get(canonicalSearch) : undefined;
  if (!descriptor) {
    return createApiResponse(null, { status: 404 });
  }

  try {
    const bytes = await readFont(descriptor);
    if (descriptor.expectedBytes !== undefined && bytes.byteLength !== descriptor.expectedBytes) {
      return createApiResponse(null, { status: 503 });
    }
    return createImmutableAssetResponse(new Uint8Array(bytes).buffer, {
      headers: {
        'Content-Type': descriptor.contentType,
        'Content-Length': String(bytes.byteLength),
        ETag: descriptor.etag,
        ...(descriptor.locale === 'zh'
          ? { Link: '</fonts/OFL-NotoSansSC.txt>; rel="license"' }
          : {}),
      },
    });
  } catch {
    return createApiResponse(null, { status: 503 });
  }
}
