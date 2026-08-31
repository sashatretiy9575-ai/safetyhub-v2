import { NextResponse } from '@/lib/security/api-response';
import { deleteCourseSchema, entityIdSchema } from '@/lib/validation/admin';
import { deleteCourse } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requireCapability } from '@/features/auth/server';
import { readJsonBody } from '@/lib/security/request-body';

export async function DELETE(request: Request, context: { params: Promise<{ courseId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { courseId } = await context.params;
    const parsedCourseId = entityIdSchema.safeParse(courseId);
    const parsed = deleteCourseSchema.safeParse(await readJsonBody(request));
    if (!parsedCourseId.success || !parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    await deleteCourse(parsedCourseId.data, parsed.data.expectedVersion);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
