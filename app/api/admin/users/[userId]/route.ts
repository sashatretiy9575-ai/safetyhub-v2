import { NextResponse } from '@/lib/security/api-response';
import { permanentlyDeleteUser } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { deleteUserSchema, entityIdSchema } from '@/lib/validation/admin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { userId } = await context.params;
    const [parsedUserId, parsedBody] = await Promise.all([
      Promise.resolve(entityIdSchema.safeParse(userId)),
      readJsonBody(request).then((value) => deleteUserSchema.safeParse(value)),
    ]);
    if (!parsedUserId.success || !parsedBody.success)
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const deletion = await permanentlyDeleteUser(
      parsedUserId.data,
      parsedBody.data.reason,
      requestSecurityMetadata(request),
    );
    return NextResponse.json(deletion, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
