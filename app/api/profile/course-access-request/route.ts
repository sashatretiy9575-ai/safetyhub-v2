import * as z from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { requireUser } from '@/server/auth/session';
import { readJsonBody } from '@/lib/security/request-body';
import { requestCourseAccess } from '@/server/learning/course-access-request';

const bodySchema = z.object({ slug: z.string().trim().min(1).max(120) });

/**
 * «Хочу этот курс». Idempotent: a second press answers `already_requested`
 * and does not notify the administrator again. The person's own id comes from
 * the session, never from the body.
 */
export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    // A newcomer who has not accepted the documents yet has still chosen a course.
    const context = await requireUser({ enforceLegal: false });
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json({
      status: await requestCourseAccess(context.user.id, parsed.data.slug),
    });
  } catch (error) {
    return apiError(error);
  }
}
