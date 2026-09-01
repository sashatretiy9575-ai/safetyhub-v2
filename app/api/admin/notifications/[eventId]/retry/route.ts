import { z } from 'zod';
import { retryAdminNotificationDelivery } from '@/features/admin/notifications';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { NextResponse } from '@/lib/security/api-response';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

const paramsSchema = z.object({ eventId: z.string().uuid() }).strict();

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  if (!rolloutFeatureEnabled('adminInbox')) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeAdminMutationQuota('admin.access.mutate', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(await retryAdminNotificationDelivery(parsed.data.eventId));
  } catch (error) {
    return apiError(error);
  }
}
