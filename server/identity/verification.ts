import 'server-only';

import * as z from 'zod';
import { createClient } from '@/server/supabase/server';
import { createAdminClient } from '@/server/supabase/admin';
import { requireAnyCapability } from '@/server/auth/session';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { invalidateCertificateVerificationCache } from '@/server/certificates/issuance';
import type { VerifiedIdentity } from '@/server/identity/types';

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
  education: z.string().optional(),
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

export async function getUserIdentity(targetId: string | null = null) {
  const identity = await callIdentityRpc('get_user_identity', { p_target_id: targetId });
  if (!targetId) return identity;
  await requireAnyCapability(['identity.read', 'identity.manage']);
  const { data, error } = await createAdminClient().from('profiles').select('education').eq('id', identity.userId).single();
  if (error) throw error;
  return { ...identity, education: data.education };
}

export async function verifyUserIdentity(
  targetId: string,
  values: { name: string; surname: string; job: string; organization: string; education?: string },
) {
  const result = await callIdentityRpc(values.education === undefined ? 'verify_user_identity' : 'verify_user_identity_with_education', {
    p_target_id: targetId,
    p_name: values.name,
    p_surname: values.surname,
    p_job: values.job,
    p_organization: values.organization,
    ...(values.education === undefined ? {} : { p_education: values.education }),
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
