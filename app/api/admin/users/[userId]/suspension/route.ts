import { NextResponse } from '@/lib/security/api-response';
import { entityIdSchema, suspendUserSchema } from '@/lib/validation/admin';
import { setUserSuspended } from '@/server/admin/management';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = suspendUserSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const { userId } = await context.params;
    const parsedUserId = entityIdSchema.safeParse(userId);
    if (!parsedUserId.success)
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await setUserSuspended(
      parsedUserId.data,
      parsed.data.suspended,
      parsed.data.reason,
      requestSecurityMetadata(request),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
