import 'server-only';

import * as z from 'zod';
import { ADMIN_COURSE_ACCESS_LIMIT } from '@/lib/constants';
import { createAdminClient } from '@/server/supabase/admin';

/** One course an administrator can open to a learner. */
export type AdminCourseOption = { id: string; title: string; slug: string };

export type UserCourseAccess = AdminCourseOption & { granted: boolean };

/**
 * What the employee card asks for. The card sends a delta; a tab that was open
 * before the delta existed still sends the whole set it believes in.
 */
export type CourseAccessChange =
  { kind: 'delta'; grant: string[]; revoke: string[] } | { kind: 'replace'; courseIds: string[] };

const courseIdListSchema = z
  .array(z.string().uuid())
  .max(ADMIN_COURSE_ACCESS_LIMIT)
  // Postgres prints a uuid in lower case, and the route compares ids as text.
  .transform((courseIds) => courseIds.map((courseId) => courseId.toLowerCase()));
const courseAccessDeltaSchema = z.object({ grant: courseIdListSchema, revoke: courseIdListSchema });

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

/**
 * Every course this learner may open right now, unpublished ones included. The
 * route applies a change to this list, so a course the card does not show —
 * or one a second administrator opened a minute ago — is not closed by it.
 */
export async function listGrantedCourseIds(userId: string): Promise<string[]> {
  const { data, error } = await createAdminClient()
    .from('course_access_grants')
    .select('test_id')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map((row) => row.test_id).sort();
}

/** The published courses, each marked with whether this learner may open it. */
export async function getUserCourseAccess(userId: string): Promise<UserCourseAccess[]> {
  const [courses, grantedIds] = await Promise.all([
    listAdminCourseOptions(),
    listGrantedCourseIds(userId),
  ]);
  const granted = new Set(grantedIds);
  return courses.map((course) => ({ ...course, granted: granted.has(course.id) }));
}

/** `null` for a body that is neither form, or that opens and closes one course at once. */
export function parseCourseAccessChange(body: unknown): CourseAccessChange | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { courseIds, grant, revoke } = body as Record<string, unknown>;
  if (grant === undefined && revoke === undefined) {
    const legacy = courseIdListSchema.safeParse(courseIds);
    return legacy.success ? { kind: 'replace', courseIds: legacy.data } : null;
  }
  const delta = courseAccessDeltaSchema.safeParse({ grant, revoke });
  if (!delta.success) return null;
  const granted = new Set(delta.data.grant);
  if (delta.data.revoke.some((courseId) => granted.has(courseId))) return null;
  return { kind: 'delta', grant: delta.data.grant, revoke: delta.data.revoke };
}
