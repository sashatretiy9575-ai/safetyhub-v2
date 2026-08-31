import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { getAdminLearningHistory, deleteAdminLearningHistory } from '@/features/admin/server';
import { learningHistoryDeleteSchema } from '@/lib/validation/admin';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requireCapability } from '@/features/auth/server';

const paramsSchema = z.object({ userId: z.string().uuid() });

export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    return NextResponse.json(await getAdminLearningHistory(params.data.userId));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [params, body] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      learningHistoryDeleteSchema.safeParseAsync(await readJsonBody(request, 16 * 1024)),
    ]);
    if (!params.success || !body.success)
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireCapability('results.delete');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(
      await deleteAdminLearningHistory(
        params.data.userId,
        body.data.reason,
        body.data.idempotencyKey,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
