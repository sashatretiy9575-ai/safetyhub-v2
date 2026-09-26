import { requireCapability } from '@/server/auth/session';
import { NextResponse } from '@/lib/security/api-response';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { zhUsernamePasswordApiError } from '@/server/auth/zh-username-password-api';
import { resetZhUsernamePassword } from '@/server/auth/zh-username-password';
import { zhUsernamePasswordResetSchema } from '@/lib/auth/zh-username-password-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeCoarseQuota } from '@/server/security/rate-limit';
import { entityIdSchema } from '@/lib/validation/admin';

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { userId } = await context.params;
    const [parsedUserId, parsedBody] = await Promise.all([
      Promise.resolve(entityIdSchema.safeParse(userId)),
      readJsonBody(request, 8192).then((body) => zhUsernamePasswordResetSchema.safeParse(body)),
    ]);
    if (!parsedUserId.success || !parsedBody.success) {
      return NextResponse.json({ error: 'ZH_RECOVERY_FAILED' }, { status: 403 });
    }
    await requireCapability('identity.manage');
    await consumeCoarseQuota('admin.zh_credential.reset', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(await resetZhUsernamePassword(parsedUserId.data, parsedBody.data));
  } catch (error) {
    return zhUsernamePasswordApiError(error);
  }
}
