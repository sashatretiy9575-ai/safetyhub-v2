import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import * as z from 'zod';
import { requireCapability } from '@/server/auth/session';
import type { CertificateBranding } from '@/lib/pdf/certificate-client-contract';
import { createAdminClient } from '@/server/supabase/admin';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { DOCUMENT_DEFAULTS, documentDate, numberFromDate } from '@/lib/pdf/document-editor';

/** One PNG, at most this many bytes once decoded. */
export const CERTIFICATE_IMAGE_MAX_BYTES = 400 * 1024;
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/u;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const text = (maximum: number) => z.string().max(maximum);
export const documentDefaultsSchema = z.object({
  reviewerName: text(200),
  commission: z.array(z.object({ name: text(200), position: text(200) }).strict()).max(20),
  companyName: text(200), programName: text(240), protocolText: text(1000),
  insertWidthCm: z.number().min(8).max(60).nullable().optional(),
  insertHeightCm: z.number().min(4).max(30).nullable().optional(),
}).strict();

/** The row as the admin page and the renderer see it; images are flags here. */
export const certificateSettingsSchema = z.object({
  documentDefaults: documentDefaultsSchema.default(DOCUMENT_DEFAULTS),
  organizationName: text(200),
  bin: text(32),
  chairmanName: text(200),
  chairmanPosition: text(200),
  memberName: text(200),
  memberPosition: text(200),
  secondMemberName: text(200),
  secondMemberPosition: text(200),
  protocolNumber: text(64),
  validityMonths: z.number().int().min(0).max(120),
  examTextKk: text(1000),
  examTextRu: text(1000),
  knowledgeTextKk: text(1000),
  knowledgeTextRu: text(1000),
  hasStamp: z.boolean(),
  hasChairmanSignature: z.boolean(),
  hasMemberSignature: z.boolean(),
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export type CertificateSettings = z.infer<typeof certificateSettingsSchema>;

const withImagesSchema = certificateSettingsSchema.extend({
  stampPng: z.string().nullable(),
  chairmanSignaturePng: z.string().nullable(),
  memberSignaturePng: z.string().nullable(),
});
export type CertificateSettingsWithImages = z.infer<typeof withImagesSchema>;

export type CertificateImageKind = 'stamp' | 'chairman' | 'member';

/** A PNG the administrator uploaded, checked by its bytes rather than its name. */
export function decodeCertificateImage(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const match = PNG_DATA_URL.exec(value);
  if (!match || !match[1]) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.byteLength < 24 || bytes.byteLength > CERTIFICATE_IMAGE_MAX_BYTES) return null;
  if (!PNG_MAGIC.every((byte, index) => bytes[index] === byte)) return null;
  return new Uint8Array(bytes);
}

/** The patch the admin page sends: only the keys being changed. */
export const certificateSettingsPatchSchema = z
  .object({
    documentDefaults: documentDefaultsSchema.optional(),
    organizationName: text(200).optional(),
    bin: text(32).optional(),
    chairmanName: text(200).optional(),
    chairmanPosition: text(200).optional(),
    memberName: text(200).optional(),
    memberPosition: text(200).optional(),
    secondMemberName: text(200).optional(),
    secondMemberPosition: text(200).optional(),
    protocolNumber: text(64).optional(),
    validityMonths: z.number().int().min(0).max(120).optional(),
    examTextKk: text(1000).optional(),
    examTextRu: text(1000).optional(),
    knowledgeTextKk: text(1000).optional(),
    knowledgeTextRu: text(1000).optional(),
    // null clears the image; a data URL replaces it; absent leaves it.
    stampPng: z.never().optional(),
    chairmanSignaturePng: z.never().optional(),
    memberSignaturePng: z.never().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['stampPng', 'chairmanSignaturePng', 'memberSignaturePng'] as const) {
      const image = value[key];
      if (typeof image === 'string' && !decodeCertificateImage(image)) {
        context.addIssue({ code: 'custom', path: [key], message: 'CERTIFICATE_IMAGE_INVALID' });
      }
    }
  });
export type CertificateSettingsPatch = z.infer<typeof certificateSettingsPatchSchema>;

type RpcClient = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export class CertificateSettingsConflictError extends Error {
  constructor() {
    super('CERTIFICATE_SETTINGS_VERSION_CONFLICT');
  }
}

/** Server-side read through the service role: the renderer and the image route. */
export async function readCertificateSettingsWithImages(): Promise<CertificateSettingsWithImages> {
  const client = createAdminClient() as unknown as RpcClient;
  const { data, error } = await client.rpc('get_certificate_settings', {
    p_include_images: true,
  });
  if (error) throw error;
  const parsed = withImagesSchema.safeParse(data);
  if (!parsed.success) throw new Error('CERTIFICATE_SETTINGS_INVALID');
  return parsed.data;
}

/** What the admin page shows: everything but the image bytes. */
export async function readCertificateSettings(): Promise<CertificateSettings> {
  await requireCapability('site.settings.manage');
  const client = (await createClient()) as unknown as RpcClient;
  const { data, error } = await client.rpc('get_certificate_settings', {
    p_include_images: false,
  });
  if (error) throw error;
  const parsed = certificateSettingsSchema.safeParse(data);
  if (!parsed.success) throw new Error('CERTIFICATE_SETTINGS_INVALID');
  return parsed.data;
}

export async function updateCertificateSettings(
  patch: CertificateSettingsPatch,
): Promise<CertificateSettings> {
  await requireCapability('site.settings.manage');
  const { expectedVersion, ...fields } = patch;
  const client = (await createClient()) as unknown as RpcClient;
  const response = await client.rpc('update_certificate_settings', {
    p_patch: fields,
    p_expected_version: expectedVersion,
  });
  let payload: unknown;
  try {
    payload = unwrapRpcMutationResponse(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes('CERTIFICATE_SETTINGS_VERSION_CONFLICT')) {
      throw new CertificateSettingsConflictError();
    }
    throw error;
  }
  const parsed = certificateSettingsSchema.safeParse(payload);
  if (!parsed.success) throw new Error('CERTIFICATE_SETTINGS_RESPONSE_INVALID');
  revalidateTag(CERTIFICATE_SETTINGS_CACHE_TAG, { expire: 0 });
  return parsed.data;
}

export function certificateImageUrl(kind: CertificateImageKind, version: number) {
  return `/certificate-assets/image?kind=${kind}&v=${version}`;
}

/**
 * The part of the settings a certificate is drawn with. Computed once per
 * request and copied into every certificate's render metadata, so a change in
 * the settings applies to every certificate downloaded afterwards — the owner
 * sets the booklet up once and every certificate looks the same.
 */
export function certificateBranding(
  settings: CertificateSettingsWithImages | CertificateSettings,
): CertificateBranding {
  return {
    documentDefaults: settings.documentDefaults,
    organizationName: settings.organizationName,
    bin: settings.bin,
    chairmanName: settings.chairmanName,
    chairmanPosition: settings.chairmanPosition,
    memberName: settings.memberName,
    memberPosition: settings.memberPosition,
    secondMemberName: settings.secondMemberName,
    secondMemberPosition: settings.secondMemberPosition,
    protocolNumber: numberFromDate(documentDate()),
    validityMonths: settings.validityMonths,
    examTextKk: settings.examTextKk,
    examTextRu: settings.examTextRu,
    knowledgeTextKk: settings.knowledgeTextKk,
    knowledgeTextRu: settings.knowledgeTextRu,
    stampUrl: null,
    chairmanSignatureUrl: null,
    memberSignatureUrl: null,
  };
}

export const CERTIFICATE_SETTINGS_CACHE_TAG = 'certificate:settings:v1';

/**
 * Service-role read without the image bytes, cached until the administrator
 * saves the settings again. Every certificate download and export reads this;
 * the previous version pulled three base64 PNGs out of Postgres each time and
 * used only the `has*` booleans.
 */
const readCertificateBrandingCached = unstable_cache(
  async (): Promise<CertificateSettings> => {
    const client = createAdminClient() as unknown as RpcClient;
    const { data, error } = await client.rpc('get_certificate_settings', {
      p_include_images: false,
    });
    if (error) throw error;
    const parsed = certificateSettingsSchema.safeParse(data);
    if (!parsed.success) throw new Error('CERTIFICATE_SETTINGS_INVALID');
    return parsed.data;
  },
  ['certificate-branding-v1'],
  { revalidate: 60 * 60, tags: [CERTIFICATE_SETTINGS_CACHE_TAG] },
);

/** The uploaded PNGs, cached per settings version until the next save. */
export const readCertificateImagesCached = unstable_cache(
  async (): Promise<CertificateSettingsWithImages> => readCertificateSettingsWithImages(),
  ['certificate-images-v1'],
  { revalidate: 60 * 60, tags: [CERTIFICATE_SETTINGS_CACHE_TAG] },
);

export async function loadCertificateBranding(): Promise<CertificateBranding> {
  return certificateBranding(await readCertificateBrandingCached());
}
