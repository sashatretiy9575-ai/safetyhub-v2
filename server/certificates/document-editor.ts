import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import { requireCapability } from '@/server/auth/session';
import { createClient } from '@/server/supabase/server';
import { createAdminClient } from '@/server/supabase/admin';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import type { DocumentBatch } from '@/lib/pdf/document-editor';

export const documentBatchSchema = z.object({
  organization: z.string().trim().min(1).max(200), courseSlug: z.string().min(1).max(160),
  date: z.iso.date(), number: z.string().trim().min(1).max(64), automatic: z.boolean(),
  version: z.number().int().nonnegative(),
  profileId: z.string().max(120).nullable().optional(),
}).strict();
type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{data: unknown; error: {message: string; code?: string} | null}> };
const batchRowSchema = z.object({
  id: z.string().uuid(), organization: z.string(), course_slug: z.string(), document_date: z.iso.date(),
  protocol_number: z.string(), automatic: z.boolean(), version: z.number().int(),
  profile_id: z.string().nullable().optional(),
});
function mapBatch(raw: unknown): DocumentBatch {
  const b = batchRowSchema.parse(raw);
  return { id: b.id, organization: b.organization, courseSlug: b.course_slug, date: b.document_date, number: b.protocol_number, automatic: b.automatic, version: b.version, profileId: b.profile_id ?? null };
}
const editorSchema = z.object({
  organizations: z.array(z.string()), courses: z.array(z.object({ id: z.string().uuid(), slug: z.string(), title: z.string() })),
  batch: batchRowSchema.nullable(),
  participants: z.array(z.object({
    userId: z.string().uuid(), fullName: z.string(), position: z.string(),
    education: z.string().default(''), photoUrl: z.string().nullable().default(null),
    trainingReason: z.string().default(''), notes: z.string().default(''), qualificationDecision: z.string().default(''),
    formalExamReference: z.string().default(''), formalExamDate: z.string().default(''), formalExamResult: z.string().default(''), formalExamProfileId: z.string().optional(), formalExamProfileVersion: z.number().int().optional(),
    status: z.enum(['passed','failed','started','expired','none']), score: z.number().nullable(), total: z.number().nullable(), certificateId: z.string().uuid().nullable(),
  })),
});
export async function readDocumentEditor(organization?: string, courseSlug?: string) {
  await requireCapability('site.settings.manage');
  await requireCapability('results.read');
  await requireCapability('certificate.read');
  if (courseSlug && /^[0-9a-f-]{36}$/iu.test(courseSlug)) {
    const course = await createAdminClient().from('tests').select('slug').eq('id', courseSlug).maybeSingle();
    if (course.error) throw course.error;
    courseSlug = course.data?.slug ?? courseSlug;
  }
  const client = await createClient() as unknown as RpcClient;
  const result = unwrapRpcMutationResponse(await client.rpc('get_document_editor_data', { p_organization: organization || null, p_course_slug: courseSlug || null }));
  const parsed = editorSchema.parse(result);
  return { ...parsed, batch: parsed.batch ? mapBatch(parsed.batch) : null };
}
export async function saveDocumentBatch(batch: z.infer<typeof documentBatchSchema>) {
  await requireCapability('site.settings.manage');
  await requireCapability('results.export');
  const client = await createClient() as unknown as RpcClient;
  return mapBatch(unwrapRpcMutationResponse(await client.rpc('save_document_batch', {
    p_organization: batch.organization, p_course_slug: batch.courseSlug, p_date: batch.date,
    p_number: batch.number, p_automatic: batch.automatic, p_version: batch.version,
    p_profile_id: batch.profileId ?? null,
  })));
}
// Only called after a certificate download payload has passed its existing access gate.
export const findCertificateDocumentBatch = cache(async (organization: string, courseSlug: string) => {
  const { data, error } = await createAdminClient().from('document_batches')
    .select('*').eq('organization_key', organization.trim().toLocaleLowerCase('ru-RU')).eq('course_slug', courseSlug).maybeSingle();
  if (error) throw error;
  return data ? mapBatch(data) : null;
});
