import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeCoarseQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { NextResponse } from '@/lib/security/api-response';
import { CERTIFICATE_EXPORT_JOB_LIMIT } from '@/lib/constants';

const requestSchema = z
  .object({
    attestationIds: z
      .array(z.string().uuid())
      .min(1)
      .max(CERTIFICATE_EXPORT_JOB_LIMIT)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

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
    await requireCapability('results.export');
    await requireCapability('certificate.read');
    await consumeCoarseQuota('certificate.export', requestSecurityMetadata(request).ipHash);
    const parsed = requestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
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
