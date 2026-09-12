import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { getSiteUrl, requireCapability, requireUser } from '@/server/auth/session';
import {
  createCertificateRenderMetadata,
  getCertificateDownloadPayload,
} from '@/server/certificates/issuance';
import { loadCertificateBranding } from '@/server/certificates/settings';
import {
  CERTIFICATE_METADATA_MAX_BYTES,
  createBoundedCertificateMetadataResponse,
} from '@/server/certificates/metadata-response';
import { consumeBusinessQuota } from '@/server/security/rate-limit';
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
    const metadata = await createCertificateRenderMetadata(
      data,
      getSiteUrl(),
      await loadCertificateBranding(),
    );
    return createBoundedCertificateMetadataResponse(metadata, CERTIFICATE_METADATA_MAX_BYTES);
  } catch (error) {
    return apiError(error);
  }
}
