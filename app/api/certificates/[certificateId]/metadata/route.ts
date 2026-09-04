import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { getSiteUrl, requireCapability, requireUser } from '@/features/auth/server';
import {
  createCertificateRenderMetadata,
  getCertificateDownloadPayload,
} from '@/features/certificates/server';
import {
  CERTIFICATE_METADATA_MAX_BYTES,
  createBoundedCertificateMetadataResponse,
} from '@/features/certificates/metadata-response';
import { consumeBusinessQuota } from '@/lib/security/rate-limit';
import { NextResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    if (!data) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const metadata = await createCertificateRenderMetadata(data, getSiteUrl());
    return createBoundedCertificateMetadataResponse(metadata, CERTIFICATE_METADATA_MAX_BYTES);
  } catch (error) {
    return apiError(error);
  }
}
