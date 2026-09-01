import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

export type AdminMutationQuotaAction =
  | 'admin.attestation.mutate'
  | 'admin.identity.mutate'
  | 'admin.certificate.revoke'
  | 'admin.access.mutate'
  | 'admin.test.mutate'
  | 'content.article.mutate'
  | 'site.settings.update';

type QuotaAction =
  | 'auth.register'
  | 'auth.otp.start'
  | 'auth.otp.start.email'
  | 'auth.otp.verify'
  | 'auth.otp.verify.email'
  | 'auth.zh.registration.options'
  | 'auth.zh.registration.verify'
  | 'auth.zh.authentication.options'
  | 'auth.zh.authentication.verify'
  | 'auth.zh.authentication.credential'
  | 'auth.zh.recovery.options'
  | 'auth.zh.recovery.verify'
  | 'auth.zh.recovery.locator'
  | 'profile.update'
  | 'attempt.start'
  | 'attempt.complete'
  | 'presentation.download'
  | 'certificate.pdf'
  | 'certificate.export'
  | 'admin.invite'
  | 'admin.suspend'
  | 'admin.delete'
  | 'admin.reconcile'
  | 'admin.zh_credential.reset'
  | AdminMutationQuotaAction;

type BusinessQuotaAction =
  | 'avatar.upload'
  | 'certificate.pdf'
  | 'presentation.download'
  | 'profile.update';

type QuotaPayload = { allowed?: unknown; retryAfter?: unknown };
type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export class RateLimitError extends Error {
  readonly status = 429;

  constructor(public readonly retryAfter: number) {
    super('RATE_LIMITED');
  }
}

function parseQuota(data: unknown) {
  const payload = data as QuotaPayload | null;
  const retryAfter = Math.max(1, Math.ceil(Number(payload?.retryAfter) || 1));
  if (!payload || payload.allowed !== true) throw new RateLimitError(retryAfter);
}

export function normalizeRateLimitError(error: unknown): never {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : String(error);
  const match = message.match(/RATE_LIMITED:(\d+)/);
  if (match) throw new RateLimitError(Math.max(1, Number(match[1])));
  throw error;
}

export async function consumeBusinessQuota(action: BusinessQuotaAction, actorId: string) {
  const client = createAdminClient() as unknown as RpcClient;
  const { data, error } = await client.rpc('consume_business_quota_for_actor', {
    p_actor_id: actorId,
    p_action: action,
  });
  if (error) normalizeRateLimitError(error);
  parseQuota(data);
}

export async function consumeAdminMutationQuota(action: AdminMutationQuotaAction, ipHash: string) {
  // Actor quotas are consumed atomically inside each authenticated mutation
  // RPC. The app layer independently limits a compromised actor/network before
  // entering the mutation, without double-counting successful operations.
  await consumeCoarseQuota(action, ipHash);
}

export async function consumeCoarseQuota(action: QuotaAction, ipHash: string) {
  const client = createAdminClient() as unknown as RpcClient;
  const { data, error } = await client.rpc('consume_coarse_ip_quota', {
    p_action: action,
    p_ip_hash: ipHash,
  });
  if (error) normalizeRateLimitError(error);
  parseQuota(data);
}
