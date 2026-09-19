import 'server-only';
import { z } from 'zod';
import { createAdminClient } from '@/server/supabase/admin';
import { createClient } from '@/server/supabase/server';
import { requireCapability } from '@/server/auth/session';
import { DOCUMENT_FAMILIES } from '@/lib/pdf/document-profile';

export const documentProfileSchema = z.object({
  revision: z.number().int().positive().optional(),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,119}$/u), courseSlug: z.string().min(1).max(160),
  audience: z.enum(['all', 'worker', 'itr']), label: z.string().min(1).max(200),
  programName: z.string().min(1).max(240), family: z.enum(DOCUMENT_FAMILIES),
  hours: z.number().int().positive().max(5000).nullable(), validityMonths: z.number().int().min(0).max(120),
  protocolText: z.string().max(1000), decisionText: z.string().max(1000),
  orderNumber: z.string().max(100), orderDate: z.union([z.iso.date(), z.literal('')]), verificationKind: z.string().max(120),
  commission: z.array(z.object({ signerId: z.string().min(1).max(80), name: z.string().min(1).max(200), position: z.string().max(200), assetId: z.string().uuid().nullable() }).strict()).min(1).max(6),
  stampAssetId: z.string().uuid().nullable(),
}).strict();

export async function readDocumentProfiles() {
  await requireCapability('site.settings.manage');
  const client = createAdminClient();
  // Every save moves a row to the end of the heap; without an order the list
  // (and the registry of signatures built from it) would reshuffle after one.
  const { data, error } = await client.from('document_profiles').select('body,version').order('id');
  if (error) throw error;
  return (data ?? []).map(row => ({ ...documentProfileSchema.parse(row.body), revision: row.version }));
}

export async function selectDocumentProfile(batchId: string, profileId: string, version: number) {
  await requireCapability('site.settings.manage');
  await requireCapability('results.export');
  const { data, error } = await (await createClient()).rpc('select_document_profile', { p_batch_id: batchId, p_profile_id: profileId, p_version: version });
  if (error) throw error;
  return data;
}

export async function readArchivedDocumentSettings(version: number) {
  const result = await createAdminClient().from('certificate_settings_versions').select('payload').eq('version', version).maybeSingle();
  if (result.error) throw result.error;
  return result.data?.payload ?? null;
}

export async function readRegisteredDocumentAsset(id: string) {
  const client = createAdminClient();
  const result = await client.from('document_assets').select('object_key').eq('id', id).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  const image = await client.storage.from('document-facsimiles').download(result.data.object_key);
  if (image.error) throw image.error;
  if (image.data.size > 2097152) throw new Error('DOCUMENT_ASSET_TOO_LARGE');
  return new Uint8Array(await image.data.arrayBuffer());
}
