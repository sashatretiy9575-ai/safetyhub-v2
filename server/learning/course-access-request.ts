import 'server-only';

import { createAdminClient } from '@/server/supabase/admin';

export const COURSE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type CourseAccessRequestStatus =
  'requested' | 'already_requested' | 'granted' | 'unknown' | 'unavailable';

type RequestRpcClient = {
  rpc(
    name: 'request_course_access_from_trusted_server',
    args: { p_user_id: string; p_slug: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Records that this person wants the course behind `slug`. A newcomer's course
 * waits for their application; an approved person's request reaches the
 * administrator at once as a «повторная заявка».
 */
export async function requestCourseAccess(
  userId: string,
  slug: string,
): Promise<CourseAccessRequestStatus> {
  if (!slug || slug.length > 120 || !COURSE_SLUG_PATTERN.test(slug)) return 'unknown';
  const { data, error } = await (createAdminClient() as unknown as RequestRpcClient).rpc(
    'request_course_access_from_trusted_server',
    { p_user_id: userId, p_slug: slug },
  );
  if (error) throw error;
  const status =
    data && typeof data === 'object' && 'status' in data ? String(data.status) : 'unknown';
  return (
    ['requested', 'already_requested', 'granted', 'unknown', 'unavailable'] as const
  ).includes(status as CourseAccessRequestStatus)
    ? (status as CourseAccessRequestStatus)
    : 'unknown';
}

/** Whether this person already has an open request for the course behind `slug`. */
export async function hasOpenCourseAccessRequest(userId: string, slug: string) {
  const admin = createAdminClient();
  const { data: course, error: courseError } = await admin
    .from('tests')
    .select('id')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();
  if (courseError || !course) return false;
  const { data, error } = await admin
    .from('course_access_requests')
    .select('test_id')
    .eq('user_id', userId)
    .eq('test_id', course.id)
    .maybeSingle();
  return !error && data !== null;
}
