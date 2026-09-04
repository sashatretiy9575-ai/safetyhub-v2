import { NextResponse } from '@/lib/security/api-response';
import { setProductRoleByEmail, setProductRoleByUserId } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { operatorRoleByEmailSchema, operatorRoleByIdSchema } from '@/lib/validation/admin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';

/** Appoints an administrator by the email address they sign in with. */
export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = operatorRoleByEmailSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('role.manage');
    const metadata = requestSecurityMetadata(request);
    await consumeAdminMutationQuota('admin.access.mutate', metadata.ipHash);
    return NextResponse.json(
      await setProductRoleByEmail(
        parsed.data.email,
        parsed.data.role,
        parsed.data.reason,
        parsed.data.idempotencyKey,
        metadata,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}

/** Withdraws administrator access from an account already shown in the list. */
export async function PATCH(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = operatorRoleByIdSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('role.manage');
    const metadata = requestSecurityMetadata(request);
    await consumeAdminMutationQuota('admin.access.mutate', metadata.ipHash);
    return NextResponse.json(
      await setProductRoleByUserId(
        parsed.data.userId,
        parsed.data.role,
        parsed.data.reason,
        parsed.data.idempotencyKey,
        metadata,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
