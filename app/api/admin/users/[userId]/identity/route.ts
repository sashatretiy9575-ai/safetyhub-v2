import { NextResponse } from '@/lib/security/api-response';
import { requireAnyCapability, requireCapability } from '@/server/auth/session';
import { identityApiError } from '@/server/identity/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import {
  getUserIdentity,
  revokeUserIdentity,
  verifyUserIdentity,
} from '@/server/identity/verification';
import {
  identityActionSchema,
  identityUserIdSchema,
} from '@/lib/validation/identity';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';

async function targetId(context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  return identityUserIdSchema.safeParse(userId);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    await requireAnyCapability(['identity.read', 'identity.manage']);
    const parsedId = await targetId(context);
    if (!parsedId.success)
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    return NextResponse.json(await getUserIdentity(parsedId.data));
  } catch (error) {
    return identityApiError(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('identity.manage');
    const [parsedId, parsedBody] = await Promise.all([
      targetId(context),
      readJsonBody(request).then((body) => identityActionSchema.safeParse(body)),
    ]);
    if (!parsedId.success || !parsedBody.success)
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await consumeAdminMutationQuota(
      'admin.identity.mutate',
      requestSecurityMetadata(request).ipHash,
    );

    const identity =
      parsedBody.data.action === 'verify'
        ? await verifyUserIdentity(parsedId.data, parsedBody.data)
        : await revokeUserIdentity(parsedId.data, parsedBody.data.reason);
    return NextResponse.json(identity);
  } catch (error) {
    return identityApiError(error);
  }
}
