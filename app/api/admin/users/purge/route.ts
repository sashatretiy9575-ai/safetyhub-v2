import { NextResponse } from '@/lib/security/api-response';
import { purgeUserAccounts } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { purgeUsersSchema } from '@/lib/validation/admin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';

/**
 * Deletes a bounded batch of accounts in one call.
 *
 * The former `DELETE /api/admin/users/{id}` accepted one account per request
 * and answered 202 with a pending marker. A bulk deletion therefore both hit
 * the coarse quota after ten people and told the operator the accounts were
 * gone when nothing had been removed yet.
 */
export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = purgeUsersSchema.safeParse(await readJsonBody(request, 32 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('user.delete');
    const metadata = requestSecurityMetadata(request);
    await consumeAdminMutationQuota('admin.purge', metadata.ipHash);
    return NextResponse.json(
      await purgeUserAccounts(
        parsed.data.userIds,
        parsed.data.reason,
        parsed.data.idempotencyKey,
        metadata,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
