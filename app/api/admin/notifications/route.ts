import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { listAdminNotificationInbox } from '@/features/admin/notifications';
import { createApiResponse, NextResponse } from '@/lib/security/api-response';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(49).default(30),
    beforeOccurredAt: z.string().datetime({ offset: true }).nullable(),
    beforeId: z.string().uuid().nullable(),
  })
  .strict()
  .refine((query) => (query.beforeOccurredAt === null) === (query.beforeId === null));

export async function GET(request: Request) {
  if (!rolloutFeatureEnabled('adminInbox')) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
      beforeOccurredAt: url.searchParams.get('beforeOccurredAt'),
      beforeId: url.searchParams.get('beforeId'),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const { page, etag } = await listAdminNotificationInbox(parsed.data);
    const headers = { ETag: etag, Vary: 'Cookie' };
    if (request.headers.get('if-none-match') === etag) {
      return createApiResponse(null, { status: 304, headers });
    }
    return NextResponse.json(page, { headers });
  } catch (error) {
    return apiError(error);
  }
}
