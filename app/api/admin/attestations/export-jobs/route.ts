import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { NextResponse } from '@/lib/security/api-response';

const requestSchema = z.object({
  attestationIds: z
    .array(z.string().uuid())
    .min(1)
    .max(500)
    .refine((values) => new Set(values).size === values.length),
});

const jobSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(['queued', 'processing', 'ready', 'failed']),
  requested: z.coerce.number().int().positive(),
  eligible: z.coerce.number().int().nonnegative(),
  skipped: z.coerce.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
});

type RpcClient = {
  rpc(
    name: 'create_certificate_export_job',
    args: { p_attestation_ids: string[] },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = requestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireCapability('results.export');
    await requireCapability('certificate.read');
    await consumeCoarseQuota('certificate.export', requestSecurityMetadata(request).ipHash);
    const client = (await createClient()) as unknown as RpcClient;
    const response = await client.rpc('create_certificate_export_job', {
      p_attestation_ids: parsed.data.attestationIds,
    });
    const job = jobSchema.parse(unwrapRpcMutationResponse(response));
    return NextResponse.json(
      {
        ...job,
        statusUrl: `/api/admin/attestations/export-jobs/${job.id}`,
        downloadUrl: `/api/admin/attestations/export-jobs/${job.id}/download`,
      },
      { status: 202 },
    );
  } catch (error) {
    return apiError(error);
  }
}
