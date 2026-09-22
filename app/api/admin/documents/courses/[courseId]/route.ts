import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import {
  DocumentCourseConflictError,
  courseDocumentSaveSchema,
  saveDocumentCourse,
} from '@/server/certificates/document-courses';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const BODY_LIMIT = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Saves a course's documents: the form, the categories, the wording and the booklet at once. */
export async function PUT(request: Request, { params }: { params: Promise<{ courseId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('site.settings.manage');
    await consumeAdminMutationQuota('site.settings.update', requestSecurityMetadata(request).ipHash);
    const { courseId } = await params;
    if (!UUID.test(courseId)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const parsed = courseDocumentSaveSchema.safeParse(await readJsonBody(request, BODY_LIMIT));
    if (!parsed.success) return NextResponse.json({ error: 'DOCUMENT_COURSE_INVALID' }, { status: 400 });
    const setup = await saveDocumentCourse(courseId, parsed.data.course, parsed.data.expected);
    return NextResponse.json({ setup }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof DocumentCourseConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return apiError(error);
  }
}
