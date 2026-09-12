import { NextResponse } from '@/lib/security/api-response';
import { purgeUserAccounts } from '@/server/admin/management';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { purgeUsersSchema } from '@/lib/validation/admin';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';

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
    await requireCapability('user.delete');
    const metadata = requestSecurityMetadata(request);
    await consumeAdminMutationQuota('admin.purge', metadata.ipHash);
    const parsed = purgeUsersSchema.safeParse(await readJsonBody(request, 32 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(
      await purgeUserAccounts(
        parsed.data.userIds,
        parsed.data.reason,
        parsed.data.idempotencyKey,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
