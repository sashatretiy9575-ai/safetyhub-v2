import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { getSiteUrl, requireCapability } from '@/features/auth/server';
import {
  certificateExportFilename,
  certificateExportResultSchema,
  createCertificateExportStream,
} from '@/features/admin/certificate-export-archive';
import { attachmentContentDisposition } from '@/lib/pdf/certificate';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { createApiResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RpcClient = {
  rpc(
    name: 'resolve_certificate_export_job',
    args: { p_job_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    await requireCapability('results.export');
    await requireCapability('certificate.read');
    const { jobId } = await context.params;
    if (!z.string().uuid().safeParse(jobId).success) {
      return createApiResponse('Not found', { status: 404 });
    }
    const client = (await createClient()) as unknown as RpcClient;
    const response = await client.rpc('resolve_certificate_export_job', { p_job_id: jobId });
    const resolved = certificateExportResultSchema.parse(unwrapRpcMutationResponse(response));
    const now = new Date();
    return createApiResponse(createCertificateExportStream(resolved, now, getSiteUrl()), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': attachmentContentDisposition(certificateExportFilename(now)),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-SafetyHub-Exported-Count': String(resolved.items.length),
        'X-SafetyHub-Excluded-Count': String(resolved.skipped.length),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
