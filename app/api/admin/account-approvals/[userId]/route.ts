import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { readJsonBody } from '@/lib/security/request-body';

const paramsSchema = z.object({ userId: z.string().uuid() });
const bodySchema = z.discriminatedUnion('decision', [
  z.object({
    idempotencyKey: z.string().uuid(),
    decision: z.literal('approved'),
  }),
  z.object({
    idempotencyKey: z.string().uuid(),
    decision: z.literal('rejected'),
    reason: z.string().trim().min(3).max(500),
  }),
]);

type ApprovalDecisionRpcClient = {
  rpc(
    name: 'decide_account_approval',
    args: {
      p_idempotency_key: string;
      p_target_user_id: string;
      p_decision: 'approved' | 'rejected';
      p_reason: string | null;
    },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
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
    const response = await (await createClient() as unknown as ApprovalDecisionRpcClient).rpc(
      'decide_account_approval',
      {
        p_idempotency_key: data.idempotencyKey,
        p_target_user_id: parsedId.data.userId,
        p_decision: data.decision,
        p_reason: data.decision === 'rejected' ? data.reason : null,
      },
    );
    void actor;
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
