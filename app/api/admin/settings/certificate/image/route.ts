import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import {
  FACSIMILE_UPLOAD_MAX_BYTES,
  normalizeFacsimilePng,
} from '@/server/certificates/facsimile-image';
import {
  CERTIFICATE_IMAGE_KINDS,
  certificateImageUrls,
  saveCertificateImage,
} from '@/server/certificates/settings';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readBoundedBytes } from '@/lib/security/request-body';

export const runtime = 'nodejs';
// Decoding and re-encoding a PNG is heavier than an ordinary settings save.
export const maxDuration = 60;

function kindOf(request: Request) {
  const value = new URL(request.url).searchParams.get('kind');
  // The second commission member's slot predates the editor and has no place on it.
  return CERTIFICATE_IMAGE_KINDS.find((kind) => kind === value && kind !== 'member') ?? null;
}

async function authorize(request: Request) {
  // Authorization precedes parsing: an unauthenticated caller must not get a
  // 2 MB body read and decoded on the product's budget.
  await requireCapability('site.settings.manage');
  await consumeAdminMutationQuota('site.settings.update', requestSecurityMetadata(request).ipHash);
}

export async function PUT(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await authorize(request);
    const kind = kindOf(request);
    if (!kind) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    if ((request.headers.get('content-type') ?? '').trim().toLowerCase() !== 'image/png') {
      return NextResponse.json({ error: 'CERTIFICATE_IMAGE_INVALID' }, { status: 400 });
    }
    const png = await normalizeFacsimilePng(
      await readBoundedBytes(request, FACSIMILE_UPLOAD_MAX_BYTES),
    );
    if (!png) return NextResponse.json({ error: 'CERTIFICATE_IMAGE_INVALID' }, { status: 400 });
    const settings = await saveCertificateImage(kind, png);
    return NextResponse.json({ settings, images: certificateImageUrls(settings) });
  } catch (error) {
    if (error instanceof Error && error.message === 'CERTIFICATE_IMAGE_INVALID') {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await authorize(request);
    const kind = kindOf(request);
    if (!kind) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const settings = await saveCertificateImage(kind, null);
    return NextResponse.json({ settings, images: certificateImageUrls(settings) });
  } catch (error) {
    return apiError(error);
  }
}
