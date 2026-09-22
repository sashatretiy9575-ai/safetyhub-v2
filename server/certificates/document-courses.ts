import 'server-only';

import { z } from 'zod';
import type { CourseDocumentSetup, courseDocumentPayload } from '@/lib/pdf/document-course';
import { DOCUMENT_FAMILIES } from '@/lib/pdf/document-profile';
import { requireCapability } from '@/server/auth/session';
import { parseDocumentProfileRow } from '@/server/certificates/document-profiles';
import { createAdminClient } from '@/server/supabase/admin';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { normalizeRateLimitError } from '@/server/security/rate-limit';

type ProfileRow = { id: string; course_slug: string; audience: string; body: unknown; version: number };
type CourseRow = { id: string; slug: string; title: string; status: string };

function setupOf(course: CourseRow, rows: readonly ProfileRow[]): CourseDocumentSetup {
  return {
    courseId: course.id,
    slug: course.slug,
    title: course.title,
    published: course.status === 'published',
    profiles: rows
      .filter((row) => row.course_slug === course.slug)
      .flatMap((row) => parseDocumentProfileRow(row) ?? []),
  };
}

/** Every course with the documents it prints, in the order of the catalogue. */
export async function readDocumentCourses(): Promise<CourseDocumentSetup[]> {
  await requireCapability('site.settings.manage');
  const client = createAdminClient();
  const [courses, profiles] = await Promise.all([
    client.from('tests').select('id,slug,title,status').order('display_order').order('title'),
    client.from('document_profiles').select('id,course_slug,audience,body,version').order('id'),
  ]);
  if (courses.error) throw courses.error;
  if (profiles.error) throw profiles.error;
  return (courses.data ?? []).map((course) => setupOf(course, profiles.data ?? []));
}

/** One course by its address: the slug, or the id older links carry. */
export async function readDocumentCourse(key: string): Promise<CourseDocumentSetup | null> {
  await requireCapability('site.settings.manage');
  const client = createAdminClient();
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(key);
  const course = await client
    .from('tests')
    .select('id,slug,title,status')
    .eq(byId ? 'id' : 'slug', key)
    .maybeSingle();
  if (course.error) throw course.error;
  if (!course.data) return null;
  const profiles = await client
    .from('document_profiles')
    .select('id,course_slug,audience,body,version')
    .eq('course_slug', course.data.slug)
    .order('id');
  if (profiles.error) throw profiles.error;
  return setupOf(course.data, profiles.data ?? []);
}

const categorySchema = z
  .object({
    hours: z.number().int().min(1).max(5000).nullable(),
    validityMonths: z.number().int().min(0).max(120).nullable(),
  })
  .strict();
const bookletTexts = z
  .object({
    examTextKk: z.string().max(1000),
    examTextRu: z.string().max(1000),
    knowledgeTextKk: z.string().max(1000),
    knowledgeTextRu: z.string().max(1000),
  })
  .strict();
/** What the course page sends; the database checks the same shape again. */
export const courseDocumentSaveSchema = z
  .object({
    course: z
      .object({
        family: z.enum(DOCUMENT_FAMILIES),
        split: z.boolean(),
        programName: z.string().trim().min(1).max(240),
        protocolText: z.string().max(1000),
        decisionText: z.string().max(1000),
        orderNumber: z.string().max(100),
        orderDate: z.union([z.iso.date(), z.literal('')]),
        verificationKind: z.string().max(120),
        booklet: z.object({ layout: z.literal('standard'), texts: bookletTexts }).strict().nullable(),
        categories: z
          .object({
            all: categorySchema.optional(),
            itr: categorySchema.optional(),
            worker: categorySchema.optional(),
          })
          .strict(),
      })
      .strict(),
    expected: z.record(z.string(), z.number().int().positive()),
  })
  .strict();

export class DocumentCourseConflictError extends Error {
  constructor() {
    super('DOCUMENT_PROFILE_CONFLICT');
  }
}

const payloadSchema = z.object({
  courseId: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  profiles: z.array(
    z.object({ id: z.string(), audience: z.string(), version: z.number().int(), body: z.unknown() }),
  ),
});

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** Saves a course's documents: every category of it in one transaction. */
export async function saveDocumentCourse(
  courseId: string,
  course: ReturnType<typeof courseDocumentPayload>,
  expected: Record<string, number>,
): Promise<CourseDocumentSetup> {
  await requireCapability('site.settings.manage');
  const client = (await createClient()) as unknown as RpcClient;
  const response = await client.rpc('save_document_course', {
    p_test_id: courseId,
    p_course: course,
    p_expected: expected,
  });
  let data: unknown;
  try {
    data = unwrapRpcMutationResponse(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes('DOCUMENT_PROFILE_CONFLICT')) {
      throw new DocumentCourseConflictError();
    }
    normalizeRateLimitError(error);
  }
  const saved = payloadSchema.parse(data);
  const status = await createAdminClient().from('tests').select('status').eq('id', courseId).single();
  if (status.error) throw status.error;
  return setupOf(
    { id: saved.courseId, slug: saved.slug, title: saved.title, status: status.data.status },
    saved.profiles.map((profile) => ({ ...profile, course_slug: saved.slug })),
  );
}
