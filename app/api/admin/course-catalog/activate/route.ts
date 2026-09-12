import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { activateCourseCatalogBatch } from '@/server/admin/management';
import { requireCapability } from '@/server/auth/session';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { activateCourseCatalogBatchSchema } from '@/lib/validation/admin';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const parsed = activateCourseCatalogBatchSchema.safeParse(
      await readJsonBody(request, 16 * 1024),
    );
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(
      await activateCourseCatalogBatch(parsed.data.batchId, parsed.data.idempotencyKey),
    );
  } catch (error) {
    return apiError(error);
  }
}
