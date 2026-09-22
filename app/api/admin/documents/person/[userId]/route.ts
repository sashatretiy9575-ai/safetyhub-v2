import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { readPersonCourseDocuments } from '@/server/certificates/document-people';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One person's category and note for one course, for their card. */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    await requireCapability('certificate.issue');
    const { userId } = await params;
    const courseId = new URL(request.url).searchParams.get('course') ?? '';
    if (!UUID.test(userId) || !UUID.test(courseId)) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const documents = await readPersonCourseDocuments(userId, courseId);
    if (!documents) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ documents }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}
