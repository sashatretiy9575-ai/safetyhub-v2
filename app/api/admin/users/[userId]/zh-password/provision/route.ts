import { NextResponse } from '@/lib/security/api-response';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { zhUsernamePasswordApiError } from '@/features/auth/zh-username-password-api';
import { provisionZhUsernamePassword } from '@/features/auth/zh-username-password-server';
import { zhUsernamePasswordProvisionSchema } from '@/features/auth/zh-username-password-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { entityIdSchema } from '@/lib/validation/admin';

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { userId } = await context.params;
    const [parsedUserId, parsedBody] = await Promise.all([
      Promise.resolve(entityIdSchema.safeParse(userId)),
      readJsonBody(request, 8192).then((body) => zhUsernamePasswordProvisionSchema.safeParse(body)),
    ]);
    if (!parsedUserId.success || !parsedBody.success) {
      return NextResponse.json({ error: 'ZH_RECOVERY_FAILED' }, { status: 403 });
    }
    await consumeCoarseQuota('admin.zh_credential.reset', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(await provisionZhUsernamePassword(parsedUserId.data, parsedBody.data));
  } catch (error) {
    return zhUsernamePasswordApiError(error);
  }
}
