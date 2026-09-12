import { requireUser } from '@/features/auth/server';
import {
  decodeCertificateImage,
  readCertificateSettingsWithImages,
  type CertificateImageKind,
} from '@/features/certificates/settings';
import { createApiResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: Record<string, CertificateImageKind> = {
  stamp: 'stamp',
  chairman: 'chairman',
  member: 'member',
};

/**
 * The stamp and signature PNGs the administrator uploaded, drawn onto every
 * certificate. Any signed-in learner or administrator renders certificates
 * in the browser, so any signed-in session may read them; anonymous visitors
 * may not. `v` is the settings version, so a browser never reuses an image
 * from before the administrator replaced it.
 */
export async function GET(request: Request) {
  try {
    await requireUser({ enforceLegal: false });
  } catch {
    return createApiResponse(null, {
      status: 401,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const url = new URL(request.url);
  const kind = KINDS[url.searchParams.get('kind') ?? ''];
  const version = url.searchParams.get('v') ?? '';
  if (!kind || !/^[0-9]{1,12}$/u.test(version)) {
    return createApiResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const settings = await readCertificateSettingsWithImages();
  const dataUrl =
    kind === 'stamp'
      ? settings.stampPng
      : kind === 'chairman'
        ? settings.chairmanSignaturePng
        : settings.memberSignaturePng;
  const bytes = decodeCertificateImage(dataUrl);
  if (!bytes || String(settings.version) !== version) {
    return createApiResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  return createApiResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
