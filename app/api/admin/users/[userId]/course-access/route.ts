import * as z from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireAnyCapability, requireCapability } from '@/features/auth/server';
import { getUserCourseAccess, parseCourseIdList } from '@/features/admin/course-access';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

const paramsSchema = z.object({ userId: z.string().uuid() });

type CourseAccessRpcClient = {
  rpc(
    name: 'set_course_access',
    args: { p_target_user_id: string; p_course_ids: string[] },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** The published courses with a flag per course: may this learner open it? */
export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await requireAnyCapability(['identity.read', 'identity.manage']);
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json({ courses: await getUserCourseAccess(parsed.data.userId) });
  } catch (error) {
    return apiError(error);
  }
}

/** Replaces the learner's set of open courses; an empty list closes them all. */
export async function PUT(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('identity.manage');
    const [parsedId, body] = await Promise.all([
      context.params.then((params) => paramsSchema.safeParse(params)),
      readJsonBody(request),
    ]);
    const parsedCourses = parseCourseIdList(
      body && typeof body === 'object' ? (body as { courseIds?: unknown }).courseIds : undefined,
    );
    if (!parsedId.success || !parsedCourses.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeAdminMutationQuota(
      'admin.identity.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const response = await ((await createClient()) as unknown as CourseAccessRpcClient).rpc(
      'set_course_access',
      { p_target_user_id: parsedId.data.userId, p_course_ids: parsedCourses.data },
    );
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
