import { NextResponse } from '@/lib/security/api-response';
import { setProductRoleByEmail, setProductRoleByUserId } from '@/server/admin/management';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { operatorRoleByEmailSchema, operatorRoleByIdSchema } from '@/lib/validation/admin';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';

/** Appoints an administrator by the email address they sign in with. */
export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('role.manage');
    const metadata = requestSecurityMetadata(request);
    await consumeAdminMutationQuota('admin.access.mutate', metadata.ipHash);
    const parsed = operatorRoleByEmailSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
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
