import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { getCourseCatalogMaintenance, setCourseCatalogMaintenance } from '@/server/admin/management';
import { requireCapability } from '@/server/auth/session';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
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
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const parsed = courseCatalogMaintenanceSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(await setCourseCatalogMaintenance(parsed.data.enabled));
  } catch (error) {
    return apiError(error);
  }
}
