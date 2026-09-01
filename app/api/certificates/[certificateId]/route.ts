import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { requireCapability, requireUser } from '@/features/auth/server';
import { getCertificateDownloadPayload } from '@/features/certificates/server';
import { consumeBusinessQuota } from '@/lib/security/rate-limit';
import { NextResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Compatibility tombstone for the former server-rendered PDF endpoint.
 * Authorized clients must fetch the bounded metadata route and render locally.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ certificateId: string }> },
) {
  try {
    const auth = await requireUser();
    const { certificateId } = await context.params;
    if (!z.string().uuid().safeParse(certificateId).success) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (auth.role === 'admin') await requireCapability('certificate.read');
    await consumeBusinessQuota('certificate.pdf', auth.user.id);
    const data = await getCertificateDownloadPayload(certificateId);
    if (!data || data.revokedAt) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: 'CERTIFICATE_PDF_CLIENT_ONLY',
        metadataUrl: `/api/certificates/${certificateId}/metadata`,
      },
      { status: 409 },
    );
  } catch (error) {
    return apiError(error);
  }
}
