import { NextResponse } from '@/lib/security/api-response';
import { revokeCertificate } from '@/features/admin/certificates';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { readJsonBody } from '@/lib/security/request-body';
import { certificateIdSchema, revokeCertificateSchema } from '@/lib/validation/certificate';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requireCapability } from '@/features/auth/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ certificateId: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { certificateId } = await context.params;
    const parsedId = certificateIdSchema.safeParse(certificateId);
    const parsedBody = revokeCertificateSchema.safeParse(await readJsonBody(request));
    if (!parsedId.success || !parsedBody.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('certificate.revoke');
    await consumeAdminMutationQuota(
      'admin.certificate.revoke',
      requestSecurityMetadata(request).ipHash,
    );
    await revokeCertificate(parsedId.data, parsedBody.data.reason);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
