import 'server-only';

import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { invalidateCertificateVerificationCache } from '@/features/certificates/server';
import type { VerifiedIdentity } from './types';

type RpcError = {
  message: string;
  details?: string | null;
  code?: string;
};

type UntypedRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

const identitySchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(['unverified', 'verified', 'revoked']),
  version: z.number().int().nonnegative(),
  name: z.string(),
  surname: z.string(),
  job: z.string(),
  organization: z.string(),
  verifiedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
});

async function callIdentityRpc(name: string, args: Record<string, unknown>) {
  const client = (await createClient()) as unknown as UntypedRpcClient;
  const result = await client.rpc(name, args);
  const parsed = identitySchema.safeParse(unwrapRpcMutationResponse(result));
  if (!parsed.success) throw new Error('INVALID_IDENTITY_PAYLOAD');
  return parsed.data satisfies VerifiedIdentity;
}

export function getUserIdentity(targetId: string | null = null) {
  return callIdentityRpc('get_user_identity', { p_target_id: targetId });
}

export async function verifyUserIdentity(
  targetId: string,
  values: { name: string; surname: string; job: string; organization: string },
) {
  const result = await callIdentityRpc('verify_user_identity', {
    p_target_id: targetId,
    p_name: values.name,
    p_surname: values.surname,
    p_job: values.job,
    p_organization: values.organization,
  });
  invalidateCertificateVerificationCache();
  return result;
}

export async function revokeUserIdentity(targetId: string, reason: string) {
  const result = await callIdentityRpc('revoke_user_identity', {
    p_target_id: targetId,
    p_reason: reason,
  });
  invalidateCertificateVerificationCache();
  return result;
}
