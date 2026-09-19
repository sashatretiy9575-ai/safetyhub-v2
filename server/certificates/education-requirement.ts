import 'server-only';
import { createAdminClient } from '@/server/supabase/admin';
import { requireAnyCapability } from '@/server/auth/session';

/** Advisory UI value only. The insertion trigger validates the final captured profile. */
export async function educationRequirement(userId: string, testId: string) {
  await requireAnyCapability(['identity.read', 'identity.manage']);
  const client = createAdminClient();
  const [person, course] = await Promise.all([
    client.from('profiles').select('organization').eq('id', userId).single(),
    client.from('tests').select('slug').eq('id', testId).maybeSingle(),
  ]);
  if (person.error) throw person.error;
  if (course.error) throw course.error;
  if (!course.data) return null;
  const batch = await client
    .from('document_batches')
    .select('profile_id')
    .eq('organization_key', person.data.organization.trim().toLocaleLowerCase('ru-RU'))
    .eq('course_slug', course.data.slug)
    .maybeSingle();
  if (batch.error) throw batch.error;
  const profiles = await client
    .from('document_profiles')
    .select('id,audience,body')
    .eq('course_slug', course.data.slug);
  if (profiles.error) throw profiles.error;
  const selected = batch.data?.profile_id
    ? profiles.data.find((p) => p.id === batch.data!.profile_id)
    : profiles.data.find((p) => p.audience === 'all');
  if (!selected && profiles.data.length) return null;
  const body = selected?.body as { family?: string } | undefined;
  return !selected || body?.family === 'general' || body?.family === 'industrial';
}
