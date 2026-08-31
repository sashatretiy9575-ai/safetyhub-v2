import { NextResponse } from '@/lib/security/api-response';
import { entityIdSchema } from '@/lib/validation/admin';
import { deleteUnusedContentAsset } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requireCapability } from '@/features/auth/server';

export async function DELETE(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { assetId } = await context.params;
    const parsedAssetId = entityIdSchema.safeParse(assetId);
    if (!parsedAssetId.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    await deleteUnusedContentAsset(parsedAssetId.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
