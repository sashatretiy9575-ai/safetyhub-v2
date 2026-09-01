import { NextResponse } from '@/lib/security/api-response';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { zhWebAuthnApiError } from '@/features/auth/zh-webauthn-api';
import { resetZhCredential } from '@/features/auth/zh-webauthn-server';
import { zhAdminCredentialResetSchema } from '@/features/auth/zh-webauthn-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { entityIdSchema } from '@/lib/validation/admin';

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { userId } = await context.params;
    const [parsedUserId, parsedBody] = await Promise.all([
      Promise.resolve(entityIdSchema.safeParse(userId)),
      readJsonBody(request, 8192).then((body) => zhAdminCredentialResetSchema.safeParse(body)),
    ]);
    if (!parsedUserId.success || !parsedBody.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(
      await resetZhCredential(
        parsedUserId.data,
        parsedBody.data.reason,
        parsedBody.data.idempotencyKey,
        requestSecurityMetadata(request),
      ),
    );
  } catch (error) {
    return zhWebAuthnApiError(error);
  }
}
