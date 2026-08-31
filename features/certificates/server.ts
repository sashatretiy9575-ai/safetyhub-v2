import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  createCertificateVerificationToken,
  verifyCertificateVerificationToken,
} from '@/lib/certificates/verification';

const publicCertificateSchema = z.object({
  id: z.string().uuid(),
  certificateNumber: z.string(),
  fullName: z.string(),
  organization: z.string().nullable().optional(),
  testTitle: z.string(),
  score: z.number().int(),
  total: z.number().int().positive(),
  issuedAt: z.string(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable().optional(),
});

export const certificateDownloadPayloadSchema = z.object({
  id: z.string().uuid(),
  certificateNumber: z.string(),
  userId: z.string().uuid(),
  revisionId: z.string().uuid().nullable(),
  fullName: z.string(),
  job: z.string().nullable(),
  organization: z.string().nullable(),
  testSlug: z.string(),
  testTitle: z.string(),
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  passScore: z.number().int().nonnegative(),
  bestCompletedAt: z.string(),
  issuedAt: z.string(),
  templateVersion: z.number().int().positive(),
  revokedAt: z.string().nullable(),
});

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
    return parsed.data;
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

export async function getPublicCertificateVerification(
  token: string,
): Promise<PublicCertificateVerification | null> {
  const certificateId = verifyCertificateVerificationToken(token);
  if (!certificateId) return null;
  return getCachedPublicCertificate(certificateId);
}
