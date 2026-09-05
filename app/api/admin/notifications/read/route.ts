import { z } from 'zod';
import {
  markAdminNotificationsRead,
  markAllAdminNotificationsRead,
} from '@/features/admin/notifications';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

const bodySchema = z.union([
  z
    .object({
      eventIds: z.array(z.string().uuid()).min(1).max(100),
    })
    .strict()
    .refine((body) => new Set(body.eventIds).size === body.eventIds.length),
  z.object({ all: z.literal(true) }).strict(),
]);

export async function POST(request: Request) {
  if (!rolloutFeatureEnabled('adminInbox')) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeAdminMutationQuota('admin.access.mutate', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(
      'all' in parsed.data
        ? await markAllAdminNotificationsRead()
        : await markAdminNotificationsRead(parsed.data.eventIds),
    );
  } catch (error) {
    return apiError(error);
  }
}
