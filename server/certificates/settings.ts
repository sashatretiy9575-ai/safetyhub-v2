import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import * as z from 'zod';
import { requireCapability } from '@/server/auth/session';
import {
  certificateImageUrl,
  type CertificateBranding,
  type CertificateImageKind,
} from '@/lib/pdf/certificate-client-contract';
import { createAdminClient } from '@/server/supabase/admin';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import {
  DOCUMENT_DEFAULTS,
  INSERT_SIZE_LIMITS,
  documentDate,
  numberFromDate,
  type InsertSizeKey,
} from '@/lib/pdf/document-editor';

/** One PNG, at most this many bytes once decoded. */
export const CERTIFICATE_IMAGE_MAX_BYTES = 400 * 1024;
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/u;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const text = (maximum: number) => z.string().max(maximum);
const insertSide = (key: InsertSizeKey) =>
  z.number().min(INSERT_SIZE_LIMITS[key][0]).max(INSERT_SIZE_LIMITS[key][1]).nullable().optional();
export const documentDefaultsSchema = z.object({
  reviewerName: text(200),
  commission: z.array(z.object({ name: text(200), position: text(200) }).strict()).max(20),
  companyName: text(200), programName: text(240), protocolText: text(1000),
  insertWidthCm: insertSide('insertWidthCm'),
  insertHeightCm: insertSide('insertHeightCm'),
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
  // Absent until the facsimile migration is applied; the code may deploy first.
  hasProtocolSignature: z.boolean().default(false),
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export type CertificateSettings = z.infer<typeof certificateSettingsSchema>;

const withImagesSchema = certificateSettingsSchema.extend({
  stampPng: z.string().nullable(),
  chairmanSignaturePng: z.string().nullable(),
  memberSignaturePng: z.string().nullable(),
  protocolSignaturePng: z.string().nullable().default(null),
});
export type CertificateSettingsWithImages = z.infer<typeof withImagesSchema>;

export const CERTIFICATE_IMAGE_KINDS = [
  'stamp',
  'chairman',
  'member',
  'protocol',
] as const satisfies readonly CertificateImageKind[];
export type { CertificateImageKind };

const IMAGE_PATCH_KEY = {
  stamp: 'stampPng',
  chairman: 'chairmanSignaturePng',
  member: 'memberSignaturePng',
  protocol: 'protocolSignaturePng',
} as const satisfies Record<CertificateImageKind, keyof CertificateSettingsWithImages>;

const IMAGE_FLAG = {
  stamp: 'hasStamp',
  chairman: 'hasChairmanSignature',
  member: 'hasMemberSignature',
  protocol: 'hasProtocolSignature',
} as const satisfies Record<CertificateImageKind, keyof CertificateSettings>;

export function certificateImageDataUrl(
  settings: CertificateSettingsWithImages,
  kind: CertificateImageKind,
): string | null {
  return settings[IMAGE_PATCH_KEY[kind]];
}

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
    // An image does not fit this route's body; saveCertificateImage writes it.
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

/**
 * Replaces or removes one stamp or signature. The image is its own save: it
 * stays on every document from this moment until the administrator replaces
 * it, whatever happens to the text fields still open in the editor.
 */
export async function saveCertificateImage(
  kind: CertificateImageKind,
  png: Uint8Array | null,
): Promise<CertificateSettings> {
  await requireCapability('site.settings.manage');
  const value = png ? `data:image/png;base64,${Buffer.from(png).toString('base64')}` : null;
  if (value && !decodeCertificateImage(value)) throw new Error('CERTIFICATE_IMAGE_INVALID');
  const client = (await createClient()) as unknown as RpcClient;
  // The text fields carry their own expected version; an image has nothing to
  // merge, so it is written over whichever version is current.
  for (let attempt = 0; ; attempt++) {
    const current = await client.rpc('get_certificate_settings', { p_include_images: false });
    if (current.error) throw current.error;
    const before = certificateSettingsSchema.safeParse(current.data);
    if (!before.success) throw new Error('CERTIFICATE_SETTINGS_INVALID');
    const response = await client.rpc('update_certificate_settings', {
      p_patch: { [IMAGE_PATCH_KEY[kind]]: value },
      p_expected_version: before.data.version,
    });
    let payload: unknown;
    try {
      payload = unwrapRpcMutationResponse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('CERTIFICATE_SETTINGS_VERSION_CONFLICT') && attempt < 2) continue;
      if (message.includes('CERTIFICATE_IMAGE_INVALID')) throw new Error('CERTIFICATE_IMAGE_INVALID');
      throw error;
    }
    const parsed = certificateSettingsSchema.safeParse(payload);
    if (!parsed.success) throw new Error('CERTIFICATE_SETTINGS_RESPONSE_INVALID');
    revalidateTag(CERTIFICATE_SETTINGS_CACHE_TAG, { expire: 0 });
    return parsed.data;
  }
}

/** The address of every image that is set, keyed by the version that carries it. */
export function certificateImageUrls(settings: CertificateSettings) {
  const url = (kind: CertificateImageKind) =>
    settings[IMAGE_FLAG[kind]] ? certificateImageUrl(kind, settings.version) : null;
  return {
    stampUrl: url('stamp'),
    chairmanSignatureUrl: url('chairman'),
    memberSignatureUrl: url('member'),
    protocolSignatureUrl: url('protocol'),
  };
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
    ...certificateImageUrls(settings),
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
