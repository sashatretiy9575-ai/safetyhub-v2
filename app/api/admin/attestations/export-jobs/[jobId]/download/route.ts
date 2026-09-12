import * as z from 'zod';
import { apiError } from '@/features/auth/api-error';
import { getSiteUrl, requireCapability } from '@/features/auth/server';
import {
  certificateExportResultSchema,
  createCertificateExportMetadata,
} from '@/features/admin/certificate-export-archive';
import {
  CERTIFICATE_EXPORT_METADATA_MAX_BYTES,
  createBoundedCertificateMetadataResponse,
} from '@/features/certificates/metadata-response';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { createApiResponse } from '@/lib/security/api-response';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RpcClient = {
  rpc(
    name: 'resolve_certificate_export_job',
    args: { p_job_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    await requireCapability('results.export');
    await requireCapability('certificate.read');
    // A ready job stays downloadable for thirty minutes and re-resolving it
    // rebuilds the whole archive metadata, so the window was replayable at will.
    await consumeCoarseQuota(
      'certificate.export.download',
      requestSecurityMetadata(request).ipHash,
    );
    const { jobId } = await context.params;
    if (!z.string().uuid().safeParse(jobId).success) {
      return createApiResponse('Not found', { status: 404 });
    }
    const client = (await createClient()) as unknown as RpcClient;
    const response = await client.rpc('resolve_certificate_export_job', { p_job_id: jobId });
    const resolved = certificateExportResultSchema.parse(unwrapRpcMutationResponse(response));
    const now = new Date();
    const metadata = await createCertificateExportMetadata(resolved, now, getSiteUrl());
    return createBoundedCertificateMetadataResponse(
      metadata,
      CERTIFICATE_EXPORT_METADATA_MAX_BYTES,
      {
        'X-SafetyHub-Exported-Count': String(resolved.items.length),
        'X-SafetyHub-Excluded-Count': String(resolved.skipped.length),
      },
    );
  } catch (error) {
    return apiError(error);
  }
}
