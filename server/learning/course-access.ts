import 'server-only';

import { createAdminClient } from '@/server/supabase/admin';

/**
 * Whether this learner may open the published course behind `slug`. Mirrors
 * `private.has_course_access` for the course page's own status call; the
 * attempt and presentation RPCs enforce the same rule inside the database, so
 * this read only decides which message the page shows.
 *
 * An unknown or unpublished slug answers `true`: the page has already
 * resolved the course, and "no such course" is not this reader's message.
 */
export async function hasCourseAccess(userId: string, slug: string) {
  const admin = createAdminClient();
  const { data: course, error: courseError } = await admin
    .from('tests')
    .select('id')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();
  if (courseError) throw courseError;
  if (!course) return true;
  const { data: grant, error: grantError } = await admin
    .from('course_access_grants')
    .select('test_id')
    .eq('user_id', userId)
    .eq('test_id', course.id)
    .maybeSingle();
  if (grantError) throw grantError;
  return grant !== null;
}
