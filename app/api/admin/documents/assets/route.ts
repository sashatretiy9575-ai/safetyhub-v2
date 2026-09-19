import { NextResponse } from '@/lib/security/api-response';
import { readBoundedBytes } from '@/lib/security/request-body';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { DocumentAssetError, replaceDocumentAsset } from '@/server/certificates/document-assets';
import { FACSIMILE_UPLOAD_MAX_BYTES } from '@/server/certificates/facsimile-image';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota, consumeBusinessQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

export const runtime = 'nodejs';
// Decoding and re-encoding a PNG, then one write per profile, is heavier than an ordinary save.
export const maxDuration = 60;

function targetOf(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind');
  if (kind !== 'signature' && kind !== 'stamp') return null;
  // Whether anybody answers to this owner is for the profiles to say, not for the address.
  return { ownerId: params.get('owner') ?? '', kind } as const;
}

/**
 * Replaces the registered image of one signer or of the stamp. There is no
 * DELETE: issued certificates keep drawing the image they were issued with, so
 * an image is only ever superseded.
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
    // write goes through the service role, so the same budget is charged here:
    // one unit per replacement, however many profiles it rebinds.
    await consumeBusinessQuota('site.settings.update', actor.user.id);
    const target = targetOf(request);
    if (!target) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    if ((request.headers.get('content-type') ?? '').trim().toLowerCase() !== 'image/png') {
      return NextResponse.json({ error: 'CERTIFICATE_IMAGE_INVALID' }, { status: 400 });
    }
    const bytes = await readBoundedBytes(request, FACSIMILE_UPLOAD_MAX_BYTES);
    const { status, ...result } = await replaceDocumentAsset({ ...target, bytes });
    return status === 'partial'
      ? NextResponse.json({ error: 'DOCUMENT_ASSET_PARTIAL', ...result }, { status: 409 })
      : NextResponse.json(result);
  } catch (error) {
    // An owner nobody knows and a PNG that does not decode are the caller's to fix.
    if (error instanceof DocumentAssetError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    return apiError(error);
  }
}
