import { NextResponse } from '@/lib/security/api-response';
import { entityIdSchema } from '@/lib/validation/admin';
import { deleteUnusedContentAsset } from '@/server/admin/management';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requireCapability } from '@/server/auth/session';

export async function DELETE(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { assetId } = await context.params;
    await requireCapability('content.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const parsedAssetId = entityIdSchema.safeParse(assetId);
    if (!parsedAssetId.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await deleteUnusedContentAsset(parsedAssetId.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
