import { NextResponse } from '@/lib/security/api-response';
import { reconcileAuthAdminOperation } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { entityIdSchema, outboxRetrySchema } from '@/lib/validation/admin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [{ operationId }, body] = await Promise.all([
      context.params,
      readJsonBody(request),
    ]);
    const [parsedId, parsedBody] = [
      entityIdSchema.safeParse(operationId),
      outboxRetrySchema.safeParse(body),
    ];
    if (!parsedId.success || !parsedBody.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await reconcileAuthAdminOperation(
      parsedId.data,
      parsedBody.data.reason,
      requestSecurityMetadata(request),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
