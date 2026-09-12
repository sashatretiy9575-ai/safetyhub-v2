import 'server-only';

import * as z from 'zod';
import { createAdminClient } from '@/server/supabase/admin';

/** One course an administrator can open to a learner. */
export type AdminCourseOption = { id: string; title: string; slug: string };

export type UserCourseAccess = AdminCourseOption & { granted: boolean };

const courseIdListSchema = z.array(z.string().uuid()).max(200);

/**
 * Every published course, in catalogue order. The approval queue and the
 * employee card both offer this list with a checkbox per course; a draft is
 * not offered because nobody could open it yet.
 *
 * The caller has already asserted its own capability; this reads reference
 * data through the service role because the course catalogue is not a
 * per-actor read model.
 */
export async function listAdminCourseOptions(): Promise<AdminCourseOption[]> {
  const { data, error } = await createAdminClient()
    .from('tests')
    .select('id, title, slug')
    .eq('status', 'published')
    .order('display_order', { ascending: true })
    .order('title', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, title: row.title, slug: row.slug }));
}

/** The published courses, each marked with whether this learner may open it. */
export async function getUserCourseAccess(userId: string): Promise<UserCourseAccess[]> {
  const [courses, { data: grants, error }] = await Promise.all([
    listAdminCourseOptions(),
    createAdminClient().from('course_access_grants').select('test_id').eq('user_id', userId),
  ]);
  if (error) throw error;
  const granted = new Set((grants ?? []).map((row) => row.test_id));
  return courses.map((course) => ({ ...course, granted: granted.has(course.id) }));
}

export function parseCourseIdList(value: unknown) {
  return courseIdListSchema.safeParse(value);
}
