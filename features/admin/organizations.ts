import 'server-only';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireCapability } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';
import type { AdminDataResult } from './types';

const organizationSchema = z.object({
  id: z.string().uuid(),
  canonicalName: z.string().min(1).max(200),
  participants: z.coerce.number().int().nonnegative(),
});

const clusterSchema = z.object({
  left: organizationSchema,
  right: organizationSchema,
  similarity: z.coerce.number().min(0).max(1),
  activeCertificates: z.coerce.number().int().nonnegative(),
});

const clustersSchema = z.object({ items: z.array(clusterSchema).max(100) });
const previewSchema = z.object({
  target: z.object({ id: z.string().uuid(), canonicalName: z.string().min(1) }),
  profiles: z.coerce.number().int().nonnegative(),
  verifiedIdentities: z.coerce.number().int().nonnegative(),
  activeCertificates: z.coerce.number().int().nonnegative(),
});
const mergeResultSchema = z.object({
  operationId: z.string().uuid(),
  replayed: z.boolean(),
  profilesUpdated: z.coerce.number().int().nonnegative(),
  activeCertificatesAffected: z.coerce.number().int().nonnegative(),
  certificatePolicy: z.enum(['preserved', 'reissued']),
  identitiesReissued: z.coerce.number().int().nonnegative(),
  canonicalName: z.string().min(1),
});

export type OrganizationCleanupCluster = z.infer<typeof clusterSchema>;
export type OrganizationMergePreview = z.infer<typeof previewSchema>;
export type OrganizationMergeResult = z.infer<typeof mergeResultSchema>;

type RpcClient = {
  rpc(
    name:
      | 'list_organization_cleanup_clusters'
      | 'preview_organization_merge'
      | 'merge_organizations',
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

async function rpc(name: Parameters<RpcClient['rpc']>[0], args: Record<string, unknown>) {
  const client = (await createClient()) as unknown as RpcClient;
  return unwrapRpcMutationResponse(await client.rpc(name, args));
}

export async function getOrganizationCleanupClusters(): Promise<
  AdminDataResult<OrganizationCleanupCluster[]>
> {
  await requireCapability('identity.manage');
  try {
    return {
      state: 'ready',
      data: clustersSchema.parse(
        await rpc('list_organization_cleanup_clusters', { p_limit: 50 }),
      ).items,
    };
  } catch (error) {
    const correlationId = randomUUID();
    console.error('ORGANIZATION_CLEANUP_LOAD_FAILED', {
      correlationId,
      cause: safeErrorDiagnosticCode(error, 'ORGANIZATION_CLEANUP_FAILED'),
    });
    return { state: 'failed', correlationId };
  }
}

export async function previewOrganizationMerge(sourceIds: string[], targetId: string) {
  await requireCapability('identity.manage');
  return previewSchema.parse(
    await rpc('preview_organization_merge', {
      p_source_ids: z.array(z.string().uuid()).min(1).max(100).parse(sourceIds),
      p_target_id: z.string().uuid().parse(targetId),
    }),
  );
}

export async function mergeOrganizations(input: {
  idempotencyKey: string;
  sourceIds: string[];
  targetId: string;
  reissueCertificates: boolean;
  reason: string;
}) {
  await requireCapability('identity.manage');
  return mergeResultSchema.parse(
    await rpc('merge_organizations', {
      p_idempotency_key: z.string().uuid().parse(input.idempotencyKey),
      p_source_ids: z.array(z.string().uuid()).min(1).max(100).parse(input.sourceIds),
      p_target_id: z.string().uuid().parse(input.targetId),
      p_reissue_certificates: input.reissueCertificates,
      p_reason: z.string().trim().min(10).max(500).parse(input.reason),
    }),
  );
}
