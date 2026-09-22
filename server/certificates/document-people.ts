import 'server-only';

import { documentAudienceForPosition } from '@/lib/pdf/document-family-defaults';
import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';

export type PersonAudience = 'itr' | 'worker';
/** What the person card shows about one course's documents for one person. */
export type PersonCourseDocuments = {
  courseSlug: string;
  /** The course prints «ИТР» and «рабочие» on protocols of their own. */
  split: boolean;
  /** The category the person is printed in: the administrator's choice, else the position's. */
  audience: PersonAudience;
  /** The category the position alone would give. */
  positionAudience: PersonAudience;
  note: string;
};

export async function readPersonCourseDocuments(
  userId: string,
  courseId: string,
): Promise<PersonCourseDocuments | null> {
  await requireCapability('certificate.issue');
  const client = createAdminClient();
  const [person, course] = await Promise.all([
    client.from('profiles').select('job,organization,document_audience').eq('id', userId).maybeSingle(),
    client.from('tests').select('slug').eq('id', courseId).maybeSingle(),
  ]);
  if (person.error) throw person.error;
  if (course.error) throw course.error;
  if (!person.data || !course.data) return null;
  const [profiles, batches] = await Promise.all([
    client.from('document_profiles').select('audience').eq('course_slug', course.data.slug),
    client
      .from('document_batches')
      .select('organization_key,participant_fields,updated_at')
      .eq('course_slug', course.data.slug)
      .order('updated_at', { ascending: false }),
  ]);
  if (profiles.error) throw profiles.error;
  if (batches.error) throw batches.error;
  const positionAudience = documentAudienceForPosition(person.data.job);
  const organizationKey = person.data.organization.trim().toLocaleLowerCase('ru-RU');
  // The same order the issuance trigger reads it in: the present company first.
  const records = [...(batches.data ?? [])].sort(
    (a, b) => Number(b.organization_key === organizationKey) - Number(a.organization_key === organizationKey),
  );
  const fields = records
    .map((record) => (record.participant_fields as Record<string, { notes?: unknown }> | null)?.[userId])
    .find(Boolean);
  const stored = person.data.document_audience;
  return {
    courseSlug: course.data.slug,
    split:
      !(profiles.data ?? []).some((profile) => profile.audience === 'all') &&
      (profiles.data ?? []).length > 1,
    audience: stored === 'itr' || stored === 'worker' ? stored : positionAudience,
    positionAudience,
    note: typeof fields?.notes === 'string' ? fields.notes : '',
  };
}

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** Null lets the position decide again. */
export async function savePersonAudience(userId: string, audience: PersonAudience | null) {
  await requireCapability('certificate.issue');
  const client = (await createClient()) as unknown as RpcClient;
  unwrapRpcMutationResponse(
    await client.rpc('set_document_audience', { p_user_id: userId, p_audience: audience }),
  );
}

export async function savePersonNote(userId: string, courseSlug: string, notes: string) {
  await requireCapability('certificate.issue');
  const client = (await createClient()) as unknown as RpcClient;
  unwrapRpcMutationResponse(
    await client.rpc('save_document_note', {
      p_user_id: userId,
      p_course_slug: courseSlug,
      p_notes: notes,
    }),
  );
}
