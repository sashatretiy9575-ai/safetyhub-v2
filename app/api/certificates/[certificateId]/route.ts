import { z } from 'zod';
import { getSiteUrl, requireCapability, requireUser } from '@/features/auth/server';
import { apiError } from '@/features/auth/api-error';
import {
  getCertificateDownloadPayload,
  getCertificateVerificationToken,
} from '@/features/certificates/server';
import { certificateVerificationUrl } from '@/lib/certificates/verification';
import {
  attachmentContentDisposition,
  certificateFilename,
  certificatePdfFingerprint,
  generateCertificateCached,
  type CertificatePayload,
} from '@/lib/pdf/certificate';
import { consumeBusinessQuota } from '@/lib/security/rate-limit';
import { createApiResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ certificateId: string }> },
) {
  try {
    const auth = await requireUser();
    const { certificateId } = await context.params;
    if (!z.string().uuid().safeParse(certificateId).success) {
      return createApiResponse('Not found', { status: 404 });
    }
    if (auth.role === 'admin') await requireCapability('certificate.read');
    await consumeBusinessQuota('certificate.pdf', auth.user.id);

    const data = await getCertificateDownloadPayload(certificateId);
    if (!data || data.revokedAt) return createApiResponse('Not found', { status: 404 });

    const verificationToken = await getCertificateVerificationToken(data.id);
    const payload: CertificatePayload = {
      fullName: data.fullName,
      position: data.job,
      organization: data.organization,
      score: data.score,
      total: data.total,
      passScore: data.passScore,
      certificateNumber: data.certificateNumber,
      issuedAt: new Date(data.issuedAt),
      testTitle: data.testTitle,
      verificationUrl: certificateVerificationUrl(
        getSiteUrl(),
        verificationToken,
      ),
    };
    const pdf = await generateCertificateCached(
      payload,
      certificatePdfFingerprint(data.id, payload, data.templateVersion),
    );
    const filename = certificateFilename(data.certificateNumber, data.fullName);
    return createApiResponse(new Uint8Array(pdf).buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': attachmentContentDisposition(filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
