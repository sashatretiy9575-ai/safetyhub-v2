import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { requireCapability } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { NextResponse } from '@/lib/security/api-response';

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
    name: 'get_certificate_export_job',
    args: { p_job_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    await requireCapability('results.export');
    const { jobId } = await context.params;
    if (!z.string().uuid().safeParse(jobId).success) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const client = (await createClient()) as unknown as RpcClient;
    const response = await client.rpc('get_certificate_export_job', { p_job_id: jobId });
    const job = jobSchema.parse(unwrapRpcMutationResponse(response));
    return NextResponse.json({
      ...job,
      downloadUrl: `/api/admin/attestations/export-jobs/${job.id}/download`,
    });
  } catch (error) {
    return apiError(error);
  }
}
