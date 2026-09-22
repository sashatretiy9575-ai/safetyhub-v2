import { NextResponse } from '@/lib/security/api-response';
import { readBoundedBytes } from '@/lib/security/request-body';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { DocumentAssetError, registerDocumentAsset } from '@/server/certificates/document-assets';
import { FACSIMILE_UPLOAD_MAX_BYTES } from '@/server/certificates/facsimile-image';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota, consumeBusinessQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

export const runtime = 'nodejs';
// Decoding and re-encoding a PNG is heavier than an ordinary save.
export const maxDuration = 60;

function targetOf(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind');
  if (kind !== 'signature' && kind !== 'stamp') return null;
  return { ownerId: params.get('owner') ?? '', kind } as const;
}

/**
 * Stores a new image of a signer or of the stamp. There is no DELETE: issued
 * documents keep drawing the image they were issued with, so an image is only
 * ever superseded — by saving «Общее» with another one.
 */
export async function PUT(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    // Authorization precedes parsing: an unauthenticated caller must not get a
    // 2 MB body read and decoded on the product's budget.
    const actor = await requireCapability('site.settings.manage');
    await consumeAdminMutationQuota(
      'site.settings.update',
      requestSecurityMetadata(request).ipHash,
    );
    // The settings RPCs charge the administrator inside the database. This
    // write goes through the service role, so the same budget is charged here.
    await consumeBusinessQuota('site.settings.update', actor.user.id);
    const target = targetOf(request);
    if (!target) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    if ((request.headers.get('content-type') ?? '').trim().toLowerCase() !== 'image/png') {
      return NextResponse.json({ error: 'CERTIFICATE_IMAGE_INVALID' }, { status: 400 });
    }
    const bytes = await readBoundedBytes(request, FACSIMILE_UPLOAD_MAX_BYTES);
    const asset = await registerDocumentAsset({ ...target, bytes });
    return NextResponse.json({ asset }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    // An owner nobody could be and a PNG that does not decode are the caller's to fix.
    if (error instanceof DocumentAssetError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    return apiError(error);
  }
}
