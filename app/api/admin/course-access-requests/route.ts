import * as z from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { createClient } from '@/server/supabase/server';

const bodySchema = z.object({ userId: z.string().uuid(), courseId: z.string().uuid() });

type DismissRpcClient = {
  rpc(
    name: 'dismiss_course_access_request',
    args: { p_user_id: string; p_test_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/**
 * «Не открывать»: answers a repeat request without opening the course. Opening
 * it goes through the employee card's own route, which fulfils the request.
 */
export async function DELETE(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('identity.manage');
    const parsed = bodySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeAdminMutationQuota(
      'admin.identity.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const { error } = await ((await createClient()) as unknown as DismissRpcClient).rpc(
      'dismiss_course_access_request',
      { p_user_id: parsed.data.userId, p_test_id: parsed.data.courseId },
    );
    if (error) throw error;
    return NextResponse.json({ dismissed: true });
  } catch (error) {
    return apiError(error);
  }
}
