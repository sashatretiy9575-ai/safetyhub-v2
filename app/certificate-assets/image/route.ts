import { requireUser } from '@/server/auth/session';
import {
  CERTIFICATE_IMAGE_KINDS,
  certificateImageDataUrl,
  decodeCertificateImage,
  readCertificateImagesCached,
} from '@/server/certificates/settings';
import { createApiResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const kind = CERTIFICATE_IMAGE_KINDS.find((value) => value === url.searchParams.get('kind'));
  const version = url.searchParams.get('v') ?? '';
  if (!kind || !/^[0-9]{1,12}$/u.test(version)) {
    return createApiResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const settings = await readCertificateImagesCached();
  const bytes = decodeCertificateImage(certificateImageDataUrl(settings, kind));
  if (!bytes) {
    return createApiResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  // A page opened before the last save still asks for its own version. It gets
  // the picture that is on the documents now, and no browser keeps it under that
  // address: an editor left open in a second tab must not lose its preview.
  const current = String(settings.version) === version;
  return createApiResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      // Under its own version the bytes never change.
      'Cache-Control': current ? 'private, max-age=31536000, immutable' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
