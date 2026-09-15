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
  'NotoSansCJKsc-Regular-b2e9d66e.otf',
);
// The full Noto Sans CJK SC is 16.4 MB, and this file travels to the
// browser: generateCertificateInBrowser fetches it before it can draw a
// single glyph. It is now the subset built by
// scripts/subset-cjk-certificate-font.py — GB/T 2312 plus everything the
// Chinese content uses, plus Latin and Cyrillic for names.
const CJK_FONT_BYTES = 3_553_936;
const CJK_FONT_ETAG = '"b2e9d66e497b1e69e5066b8bec9433d5026aa593918d4625a03555817047f993"';

type FontDescriptor = {
  locale: 'ru' | 'kk' | 'en' | 'zh';
  path: string;
  contentType: 'font/ttf' | 'font/otf';
  expectedBytes?: number;
  etag: string;
};

const FONT_REQUESTS = new Map<string, FontDescriptor>([
  ['?face=sans&weight=bold&v=1', { locale: 'ru', path: path.join(process.cwd(), 'lib/pdf/assets/NotoSans-Bold.ttf'), contentType: 'font/ttf', etag: '"noto-sans-bold-v1"' }],
  ['?face=serif&weight=regular&v=1', { locale: 'ru', path: path.join(process.cwd(), 'lib/pdf/assets/NotoSerif-Regular.ttf'), contentType: 'font/ttf', etag: '"noto-serif-regular-v1"' }],
  ['?face=serif&weight=bold&v=1', { locale: 'ru', path: path.join(process.cwd(), 'lib/pdf/assets/NotoSerif-Bold.ttf'), contentType: 'font/ttf', etag: '"noto-serif-bold-v1"' }],
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
    '?locale=zh&v=Sans2.005',
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
