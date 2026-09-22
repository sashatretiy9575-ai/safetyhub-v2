import 'server-only';
import { z } from 'zod';
import { createAdminClient } from '@/server/supabase/admin';
import { requireCapability } from '@/server/auth/session';
import { DOCUMENT_FAMILIES, type DocumentProfileSettings } from '@/lib/pdf/document-profile';

export const documentSignerSchema = z
  .object({
    signerId: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/u),
    name: z.string().trim().min(1).max(200),
    position: z.string().max(200),
    assetId: z.string().uuid().nullable(),
  })
  .strict();
/** The commission and the stamp of «Общее», one for every course. */
export const documentCommissionSchema = z
  .object({
    signers: z.array(documentSignerSchema).min(1).max(6),
    stampAssetId: z.string().uuid().nullable(),
  })
  .strict()
  .refine(
    (value) => new Set(value.signers.map((signer) => signer.signerId)).size === value.signers.length,
    { message: 'DOCUMENT_COMMISSION_INVALID' },
  );

const bookletTextsSchema = z
  .object({
    examTextKk: z.string().max(1000),
    examTextRu: z.string().max(1000),
    knowledgeTextKk: z.string().max(1000),
    knowledgeTextRu: z.string().max(1000),
  })
  .strict();

const profileFields = {
  revision: z.number().int().positive().optional(),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,119}$/u),
  courseSlug: z.string().min(1).max(160),
  audience: z.enum(['all', 'worker', 'itr']),
  label: z.string().min(1).max(200),
  programName: z.string().min(1).max(240),
  family: z.enum(DOCUMENT_FAMILIES),
  // A blank box means "the form states it": the hours of the form are printed.
  hours: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .nullable()
    .default(null)
    .transform((value) => value || null),
  validityMonths: z.number().int().min(0).max(120).default(0),
  noExpiry: z.boolean().optional(),
  protocolText: z.string().max(1000).default(''),
  decisionText: z.string().max(1000).default(''),
  orderNumber: z.string().max(100).default(''),
  orderDate: z.union([z.iso.date(), z.literal('')]).default(''),
  verificationKind: z.string().max(120).default(''),
  booklet: z.object({ layout: z.literal('standard'), texts: bookletTextsSchema }).strict().optional(),
};

/** A course's documents for one category, as `document_profiles.body` stores them. */
export const documentProfileSettingsSchema = z.object(profileFields).strict();
/**
 * The profile a document was issued with. Issuance writes the commission of
 * the day into it; documents issued before the commission was shared carry the
 * copy their profile had.
 */
export const documentProfileSchema = z
  .object({
    ...profileFields,
    commission: z.array(documentSignerSchema).min(1).max(6),
    stampAssetId: z.string().uuid().nullable(),
  })
  .strict();

type ProfileRow = { id: string; course_slug: string; audience: string; body: unknown; version: number };

/** The row's own id, course and category win over the copies inside its body. */
export function parseDocumentProfileRow(row: ProfileRow): DocumentProfileSettings | null {
  const body = row.body && typeof row.body === 'object' ? row.body : {};
  const parsed = documentProfileSettingsSchema.safeParse({
    ...body,
    id: row.id,
    courseSlug: row.course_slug,
    audience: row.audience,
  });
  return parsed.success ? { ...parsed.data, revision: row.version } : null;
}

/**
 * Every stored profile. A row that does not read is left out rather than
 * taking the whole documents section down with it; the course it belongs to
 * shows as not set up and is saved again from its page.
 */
export async function readDocumentProfiles(): Promise<DocumentProfileSettings[]> {
  await requireCapability('site.settings.manage');
  const { data, error } = await createAdminClient()
    .from('document_profiles')
    .select('id,course_slug,audience,body,version')
    .order('id');
  if (error) throw error;
  return (data ?? []).flatMap((row) => parseDocumentProfileRow(row) ?? []);
}

export async function readArchivedDocumentSettings(version: number) {
  const result = await createAdminClient()
    .from('certificate_settings_versions')
    .select('payload')
    .eq('version', version)
    .maybeSingle();
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
