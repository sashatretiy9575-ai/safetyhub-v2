import * as z from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import {
  applyCourseAccessRequest,
  replaceListedCourseAccess,
} from '@/lib/admin/course-access-selection';
import { ADMIN_COURSE_ACCESS_LIMIT } from '@/lib/constants';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireAnyCapability, requireCapability } from '@/server/auth/session';
import {
  getUserCourseAccess,
  listAdminCourseOptions,
  listGrantedCourseIds,
  parseCourseAccessChange,
} from '@/server/admin/course-access';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

const paramsSchema = z.object({ userId: z.string().uuid() });

type CourseAccessRpcClient = {
  rpc(
    name: 'set_course_access',
    args: { p_target_user_id: string; p_course_ids: string[] },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

type CourseAccessRefusal =
  'COURSE_ACCESS_COURSE_UNKNOWN' | 'ACCOUNT_UNAVAILABLE' | 'COURSE_ACCESS_LIMIT';

/** A refusal the employee card explains in its own words; nothing was written. */
function refuse(code: CourseAccessRefusal) {
  return NextResponse.json({ error: code }, { status: 409 });
}

/**
 * `set_course_access` raises its refusals as plain Postgres errors, outside the
 * RPC envelope, and the shared mapper has no entry for them: a deleted course
 * and a suspended account both came out as SERVER_ERROR 500, so the messages
 * the card keeps for them could never be shown.
 */
function courseAccessError(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (message === 'COURSE_ACCESS_COURSE_UNKNOWN' || message === 'ACCOUNT_UNAVAILABLE') {
    return refuse(message);
  }
  return apiError(error);
}

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

/**
 * Opens and closes courses for one learner: `{ grant, revoke }`. The answer is
 * the learner's whole set afterwards, `{ userId, courseIds }`.
 */
export async function PUT(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('identity.manage');
    const [parsedId, body] = await Promise.all([
      context.params.then((params) => paramsSchema.safeParse(params)),
      readJsonBody(request),
    ]);
    const change = parseCourseAccessChange(body);
    if (!parsedId.success || !change) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeAdminMutationQuota(
      'admin.identity.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const userId = parsedId.data.userId;

    // The RPC replaces the whole set. Handing it the card's list closed every
    // course the card does not show (it lists published ones only) and undid
    // what a second administrator had just changed. So the change is applied to
    // the rows `course_access_grants` holds right now, and the RPC receives the
    // result. The read and the write are still two statements: a change that
    // lands in the few milliseconds between them can be lost.
    const current = await listGrantedCourseIds(userId);
    const next =
      change.kind === 'delta'
        ? applyCourseAccessRequest(current, change)
        : // A tab opened before the delta existed sends the set it sees.
          replaceListedCourseAccess(
            current,
            (await listAdminCourseOptions()).map((course) => course.id),
            change.courseIds,
          );
    if (next.length > ADMIN_COURSE_ACCESS_LIMIT) return refuse('COURSE_ACCESS_LIMIT');
    // A repeated request whose first answer was lost has nothing left to write.
    if (next.length === current.length && next.every((id, index) => id === current[index])) {
      return NextResponse.json({ userId, courseIds: current });
    }

    const response = await ((await createClient()) as unknown as CourseAccessRpcClient).rpc(
      'set_course_access',
      { p_target_user_id: userId, p_course_ids: next },
    );
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return courseAccessError(error);
  }
}
