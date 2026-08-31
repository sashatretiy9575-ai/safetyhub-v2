import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { retireCoursePresentation } from '@/features/admin/server';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';

const paramsSchema = z.object({
  courseId: z.string().uuid(),
  presentationId: z.string().uuid(),
});

export async function DELETE(
  request: Request,
  context: { params: Promise<{ courseId: string; presentationId: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const retired = await retireCoursePresentation(
      parsed.data.courseId,
      parsed.data.presentationId,
    );
    // The transaction only retires metadata. Storage bytes remain immutable
    // until the privileged reconciler leases an unreferenced retired object.
    return NextResponse.json(retired);
  } catch (error) {
    return apiError(error);
  }
}
