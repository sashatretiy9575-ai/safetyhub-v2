import { z } from 'zod';
import { getCertificateDownloadPayload } from '@/server/certificates/issuance';
import { certificatePhotoResponse } from '@/server/certificates/photo';
import { apiError } from '@/server/auth/api-error';
import { requireUser, requireAnyCapability, requireCapability } from '@/server/auth/session';
import { createApiResponse } from '@/lib/security/api-response';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ certificateId: string }> }) {
  try {
    const auth = await requireUser();
    if (auth.role === 'admin') {
      await requireCapability('certificate.read');
      await requireAnyCapability(['identity.read', 'identity.manage']);
    }
    const id = z.string().uuid().safeParse((await context.params).certificateId);
    if (!id.success) return createApiResponse(null, { status: 404 });
    const certificate = await getCertificateDownloadPayload(id.data);
    if (!certificate) return createApiResponse(null, { status: 404 });
    return await certificatePhotoResponse(certificate.userId, false, certificate.documentSnapshot ? certificate.documentSnapshot.photo ?? null : undefined);
  } catch (error) { return apiError(error); }
}
