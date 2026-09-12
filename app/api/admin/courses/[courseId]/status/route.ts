import { NextResponse } from '@/lib/security/api-response';
import { entityIdSchema, testStatusSchema } from '@/lib/validation/admin';
import { setTestStatus } from '@/server/admin/management';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requireCapability } from '@/server/auth/session';

export async function PATCH(request: Request, context: { params: Promise<{ courseId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const parsed = testStatusSchema.safeParse(await readJsonBody(request));
    const { courseId } = await context.params;
    const parsedCourseId = entityIdSchema.safeParse(courseId);
    if (!parsed.success || !parsedCourseId.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await setTestStatus(parsedCourseId.data, parsed.data.status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
