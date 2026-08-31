import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { getCourseCatalogMaintenance, setCourseCatalogMaintenance } from '@/features/admin/server';
import { requireCapability } from '@/features/auth/server';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { courseCatalogMaintenanceSchema } from '@/lib/validation/admin';

export async function GET() {
  try {
    return NextResponse.json(await getCourseCatalogMaintenance());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = courseCatalogMaintenanceSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(await setCourseCatalogMaintenance(parsed.data.enabled));
  } catch (error) {
    return apiError(error);
  }
}
