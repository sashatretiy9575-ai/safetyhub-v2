import 'server-only';

import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';

/** A course somebody asked for and nobody has opened or turned down yet. */
export type OpenCourseAccessRequest = {
  userId: string;
  courseId: string;
  courseTitle: string;
  requestedAt: string;
};

/** What an already approved person asked for: the «повторная заявка» list. */
export type RepeatCourseAccessRequest = OpenCourseAccessRequest & {
  name: string;
  surname: string;
  organization: string;
};

export type CourseAccessRequests = {
  /** Newcomers' courses, by person: the approval queue ticks them by default. */
  byApplicant: Record<string, string[]>;
  /** Requests from people who already train with us. */
  repeat: RepeatCourseAccessRequest[];
};

const REQUEST_LIMIT = 500;

/**
 * Every open request, split by whose it is. The approval page asserts the same
 * capability for its own queue; this reads through the service role because the
 * table is closed to browser roles.
 */
export async function listOpenCourseAccessRequests(): Promise<CourseAccessRequests> {
  await requireCapability('identity.manage');
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('course_access_requests')
    .select('user_id, test_id, requested_at')
    .order('requested_at', { ascending: true })
    .limit(REQUEST_LIMIT);
  if (error) throw error;
  const courseIds = [...new Set((data ?? []).map((row) => row.test_id))];
  const titles = new Map<string, string>();
  if (courseIds.length) {
    const courses = await admin.from('tests').select('id, title').in('id', courseIds);
    if (courses.error) throw courses.error;
    for (const course of courses.data) titles.set(course.id, course.title);
  }
  const rows = (data ?? []).map((row) => ({
    userId: row.user_id,
    courseId: row.test_id,
    requestedAt: row.requested_at,
    courseTitle: titles.get(row.test_id) ?? '',
  }));
  if (!rows.length) return { byApplicant: {}, repeat: [] };

  const userIds = [...new Set(rows.map((row) => row.userId))];
  const [controls, profiles] = await Promise.all([
    admin
      .from('account_controls')
      .select('user_id, approval_state')
      .in('user_id', userIds)
      .eq('status', 'active')
      .eq('deletion_pending', false),
    admin.from('profiles').select('id, name, surname, organization').in('id', userIds),
  ]);
  if (controls.error) throw controls.error;
  if (profiles.error) throw profiles.error;
  const state = new Map(controls.data.map((row) => [row.user_id, row.approval_state]));
  const profile = new Map(profiles.data.map((row) => [row.id, row]));

  const byApplicant: Record<string, string[]> = {};
  const repeat: RepeatCourseAccessRequest[] = [];
  for (const row of rows) {
    const approval = state.get(row.userId);
    if (approval === 'approved') {
      const person = profile.get(row.userId);
      repeat.push({
        ...row,
        name: person?.name ?? '',
        surname: person?.surname ?? '',
        organization: person?.organization ?? '',
      });
    } else if (approval === 'pending' || approval === 'profile_incomplete') {
      (byApplicant[row.userId] ??= []).push(row.courseId);
    }
  }
  return { byApplicant, repeat };
}
