import { NextResponse } from '@/lib/security/api-response';
import { getAuthContext } from '@/server/auth/session';
import { hasCourseAccess } from '@/server/learning/course-access';

export const dynamic = 'force-dynamic';

const COURSE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The learner's standing, optionally for one course (`?course=<slug>`): an
 * approved account still sees `course_locked` for a course the administrator
 * has not opened to it.
 */
export async function GET(request: Request) {
  try {
    const context = await getAuthContext();
    if (!context) {
      return NextResponse.json({ access: 'anonymous' });
    }
    if (context.role === 'admin') {
      return NextResponse.json({ access: 'approved', role: 'admin' });
    }
    if (!context.hasCurrentLegalAcceptance) {
      return NextResponse.json({ access: 'legal_required' });
    }
    if (context.approval.state === 'profile_incomplete') {
      return NextResponse.json({ access: 'profile_incomplete' });
    }
    if (context.approval.state === 'pending') {
      return NextResponse.json({ access: 'pending' });
    }
    if (context.approval.state === 'rejected') {
      return NextResponse.json({ access: 'rejected' });
    }
    const slug = new URL(request.url).searchParams.get('course') ?? '';
    if (slug && slug.length <= 120 && COURSE_SLUG.test(slug)) {
      // A failed grant lookup must never demote a signed-in learner to
      // "anonymous": before the grants migration is applied the table does
      // not exist, and the page then asked people to sign in again.
      const opened = await hasCourseAccess(context.user.id, slug).catch(() => true);
      if (!opened) {
        return NextResponse.json({ access: 'course_locked', role: context.role });
      }
    }
    return NextResponse.json({ access: 'approved', role: context.role });
  } catch {
    return NextResponse.json({ access: 'anonymous' });
  }
}
