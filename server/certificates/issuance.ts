import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import * as z from 'zod';
import { createAdminClient } from '@/server/supabase/admin';
import { createClient } from '@/server/supabase/server';
import {
  createCertificateVerificationToken,
  certificateVerificationUrl,
  verifyCertificateVerificationToken,
} from '@/server/certificates/verification';
import {
  CERTIFICATE_CLIENT_SCHEMA_VERSION,
  CERTIFICATE_LOCALES,
  type CertificateBranding,
  type CertificateLocale,
  type CertificateRenderMetadata,
} from '@/lib/pdf/certificate-client-contract';
import { certificateFilename } from '@/lib/pdf/certificate';
import { numberFromDate, documentDate } from '@/lib/pdf/document-editor';
import { certificateBranding, certificateSettingsSchema } from '@/server/certificates/settings';
import { documentProfileSchema } from '@/server/certificates/document-profiles';
import { applyDocumentProfile } from '@/lib/pdf/document-profile';

const publicCertificateSchema = z.object({
  learningAssessment: z.boolean().default(false),
  id: z.string().uuid(),
  certificateNumber: z.string(),
  fullName: z.string(),
  organization: z.string().nullable().optional(),
  testTitle: z.string(),
  score: z.number().int(),
  total: z.number().int().positive(),
  issuedAt: z.string(),
});

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableBoundedText = (maximum: number) =>
  z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().min(1).max(maximum).nullable(),
  );
const localeSchema = z.preprocess(
  (value) => (value === null || value === undefined ? 'ru' : value),
  z.enum(CERTIFICATE_LOCALES),
);
const templateVersionSchema = z.preprocess(
  (value) => (value === null || value === undefined ? 1 : value),
  z.coerce.number().int().min(1).max(100),
);

export const certificateDownloadPayloadSchema = z
  .object({
    id: z.string().uuid(),
    certificateNumber: boundedText(96),
    userId: z.string().uuid(),
    revisionId: z.string().uuid().nullable(),
    fullName: boundedText(200),
    job: nullableBoundedText(160),
    organization: nullableBoundedText(200),
    testSlug: boundedText(160),
    testTitle: boundedText(240),
    titleSnapshot: boundedText(240).nullable().optional(),
    locale: localeSchema,
    score: z.coerce.number().int().min(0).max(10_000),
    total: z.coerce.number().int().min(1).max(10_000),
    passScore: z.coerce.number().int().min(0).max(10_000),
    bestCompletedAt: z.string().datetime({ offset: true }),
    issuedAt: z.string().datetime({ offset: true }),
    templateVersion: templateVersionSchema,
    documentSnapshot: z
      .object({
        schemaVersion: z.literal(1),
        captureKind: z.enum(['issuance', 'legacy-cutover']),
        protocolLayoutVersion: z.literal(2).optional(),
        capturedAt: z.string(),
        settings: certificateSettingsSchema,
        profile: documentProfileSchema.nullable(),
        protocolNumber: boundedText(64),
        protocolDate: z.iso.date(),
        education: z.string().max(200),
        photo: z
          .object({ objectKey: z.string().max(256), legacyImported: z.boolean() })
          .nullable()
          .optional(),
        participantFields: z
          .object({
            trainingReason: z.string().max(500).optional(),
            notes: z.string().max(500).optional(),
            electricalGroup: z.string().max(8).optional(),
            electricalVoltage: z.string().max(32).optional(),
            qualificationDecision: z.string().max(500).optional(),
            formalExamReference: z.string().max(500).optional(),
            formalExamDate: z.string().optional(),
            formalExamResult: z.string().optional(),
            formalExamConfirmedBy: z.string().uuid().optional(),
            formalExamConfirmedAt: z.string().optional(),
            formalExamProfileId: z.string().optional(),
            formalExamProfileVersion: z.number().int().optional(),
          })
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.score > value.total || value.passScore > value.total) {
      context.addIssue({ code: 'custom', message: 'CERTIFICATE_SCORE_INVALID' });
    }
  })
  .transform((value) => ({
    ...value,
    titleSnapshot: value.titleSnapshot ?? value.testTitle,
  }));

export type CertificateDownloadPayload = z.infer<typeof certificateDownloadPayloadSchema>;

type CertificateRpcClient = {
  rpc(
    name: 'get_certificate_download_payload' | 'get_public_certificate',
    args: { p_certificate_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type PublicCertificateVerification = z.infer<typeof publicCertificateSchema>;

export const CERTIFICATE_VERIFICATION_CACHE_TAG = 'certificate-verification';

// QR links are deliberately shareable. Deduplicate valid-token replays in the
// deployment-wide Data Cache while leaving the PII-bearing HTML itself
// private/no-store. The short TTL also covers mutations made outside the app.
const getCachedPublicCertificate = unstable_cache(
  async (certificateId: string): Promise<PublicCertificateVerification | null> => {
    const client = createAdminClient() as unknown as CertificateRpcClient;
    const { data, error } = await client.rpc('get_public_certificate', {
      p_certificate_id: certificateId,
    });
    if (error) throw error;
    if (data === null) return null;
    const parsed = publicCertificateSchema.safeParse(data);
    if (!parsed.success) throw new Error('INVALID_CERTIFICATE_VERIFICATION_RESULT');
    const { data: record, error: recordError } = await createAdminClient()
      .from('certificates')
      .select('test_slug')
      .eq('id', parsed.data.id)
      .single();
    if (recordError) throw recordError;
    return {
      ...parsed.data,
      learningAssessment: record.test_slug === 'promyshlennaya-bezopasnost',
    };
  },
  ['public-certificate-verification-v1'],
  { revalidate: 15, tags: [CERTIFICATE_VERIFICATION_CACHE_TAG] },
);

export function invalidateCertificateVerificationCache() {
  revalidateTag(CERTIFICATE_VERIFICATION_CACHE_TAG, { expire: 0 });
}

export async function getCertificateVerificationToken(certificateId: string): Promise<string> {
  return createCertificateVerificationToken(certificateId);
}

export async function getCertificateDownloadPayload(
  certificateId: string,
): Promise<CertificateDownloadPayload | null> {
  const client = (await createClient()) as unknown as CertificateRpcClient;
  const { data, error } = await client.rpc('get_certificate_download_payload', {
    p_certificate_id: certificateId,
  });
  if (error) throw error;
  if (data === null) return null;
  const parsed = certificateDownloadPayloadSchema.safeParse(data);
  if (!parsed.success) throw new Error('INVALID_CERTIFICATE_DOWNLOAD_PAYLOAD');
  return parsed.data;
}

function certificateFontUrl(locale: CertificateLocale) {
  const version = locale === 'zh' ? 'Sans2.005' : '1';
  return `/certificate-assets/font?locale=${locale}&v=${version}`;
}

export async function createCertificateRenderMetadata(
  data: CertificateDownloadPayload,
  siteUrl: string,
  branding: CertificateBranding,
): Promise<CertificateRenderMetadata> {
  const verificationToken = await getCertificateVerificationToken(data.id);
  const snapshot = data.documentSnapshot;
  const profile = snapshot
    ? null
    : await createAdminClient()
        .from('profiles')
        .select('avatar_updated_at,education')
        .eq('id', data.userId)
        .single();
  if (profile?.error) throw profile.error;
  // Every certificate carries a snapshot since 19 September 2026; one without
  // it would be dated by the day it was issued.
  const protocolDate = snapshot?.protocolDate ?? documentDate(new Date(data.issuedAt));
  let stableBranding = snapshot ? certificateBranding(snapshot.settings) : branding;
  if (snapshot?.profile) stableBranding = applyDocumentProfile(stableBranding, snapshot.profile);
  if (snapshot?.protocolLayoutVersion)
    stableBranding = { ...stableBranding, protocolLayoutVersion: snapshot.protocolLayoutVersion };
  return {
    schemaVersion: CERTIFICATE_CLIENT_SCHEMA_VERSION,
    certificateId: data.id,
    filename: certificateFilename(data.certificateNumber, data.fullName),
    locale: data.locale,
    templateVersion: data.templateVersion,
    titleSnapshot: data.titleSnapshot,
    templateUrl: `/certificates/template-v${data.templateVersion}.pdf`,
    fontUrl: certificateFontUrl(data.locale),
    fullName: data.fullName,
    photoUrl: (snapshot ? snapshot.photo : profile?.data?.avatar_updated_at)
      ? `/api/certificates/${data.id}/photo`
      : null,
    education: snapshot?.education ?? profile?.data?.education,
    documentDetails: snapshot?.participantFields
      ? {
          trainingReason: snapshot.participantFields.trainingReason,
          notes: snapshot.participantFields.notes,
          electricalGroup: snapshot.participantFields.electricalGroup,
          electricalVoltage: snapshot.participantFields.electricalVoltage,
          qualificationDecision: snapshot.participantFields.qualificationDecision,
          formalExamReference: snapshot.participantFields.formalExamReference,
          formalExamDate: snapshot.participantFields.formalExamDate,
          formalExamResult: snapshot.participantFields.formalExamResult,
        }
      : undefined,
    position: data.job,
    organization: data.organization,
    score: data.score,
    total: data.total,
    passScore: data.passScore,
    certificateNumber: data.certificateNumber,
    completedAt: data.bestCompletedAt,
    issuedAt: data.issuedAt,
    verificationUrl: certificateVerificationUrl(siteUrl, verificationToken),
    branding: {
      ...stableBranding,
      protocolNumber: snapshot?.protocolNumber ?? numberFromDate(protocolDate),
      protocolDate,
    },
  };
}

export async function getPublicCertificateVerification(
  token: string,
): Promise<PublicCertificateVerification | null> {
  const certificateId = verifyCertificateVerificationToken(token);
  if (!certificateId) return null;
  return getCachedPublicCertificate(certificateId);
}
