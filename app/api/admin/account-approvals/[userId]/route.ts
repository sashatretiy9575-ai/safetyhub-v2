import * as z from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

const paramsSchema = z.object({ userId: z.string().uuid() });
const bodySchema = z.discriminatedUnion('decision', [
  z
    .object({
      idempotencyKey: z.string().uuid(),
      decision: z.literal('approved'),
      // Course access is manual: an approval names the courses it opens, and
      // it opens at least one, otherwise the learner is approved into nothing.
      courseIds: z.array(z.string().uuid()).min(1).max(200),
    })
    .strict(),
  z
    .object({
      idempotencyKey: z.string().uuid(),
      decision: z.literal('rejected'),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
]);

type ApprovalDecisionRpcClient = {
  rpc(
    name: 'decide_account_approval',
    args: {
      p_idempotency_key: string;
      p_target_user_id: string;
      p_decision: 'approved' | 'rejected';
      p_reason: string | null;
      p_course_ids: string[] | null;
    },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [actor, parsedId, parsedBody] = await Promise.all([
      requireCapability('identity.manage'),
      context.params.then((params) => paramsSchema.safeParse(params)),
      readJsonBody(request).then((body) => bodySchema.safeParse(body)),
    ]);
    if (!parsedId.success || !parsedBody.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    await consumeAdminMutationQuota(
      'admin.identity.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const data = parsedBody.data;
    // All five arguments are always sent so PostgREST resolves the
    // course-aware overload rather than the legacy four-argument wrapper.
    const response = await ((await createClient()) as unknown as ApprovalDecisionRpcClient).rpc(
      'decide_account_approval',
      {
        p_idempotency_key: data.idempotencyKey,
        p_target_user_id: parsedId.data.userId,
        p_decision: data.decision,
        p_reason: data.decision === 'rejected' ? data.reason : null,
        p_course_ids: data.decision === 'approved' ? data.courseIds : null,
      },
    );
    void actor;
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
