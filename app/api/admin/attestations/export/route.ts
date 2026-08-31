import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { getSiteUrl, requireCapability } from '@/features/auth/server';
import {
  certificateExportFilename,
  certificateExportResultSchema,
  createCertificateExportStream,
} from '@/features/admin/certificate-export-archive';
import { attachmentContentDisposition } from '@/lib/pdf/certificate';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { createApiResponse, NextResponse } from '@/lib/security/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const exportSchema = z.object({
  attestationIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .refine((values) => new Set(values).size === values.length, 'DUPLICATE_ATTESTATION_IDS'),
});

type RpcClient = {
  rpc(
    name: 'resolve_certificate_export',
    args: { p_attestation_ids: string[] },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = exportSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('results.export');
    await requireCapability('certificate.read');
    await consumeCoarseQuota('certificate.export', requestSecurityMetadata(request).ipHash);

    const client = (await createClient()) as unknown as RpcClient;
    const response = await client.rpc('resolve_certificate_export', {
      p_attestation_ids: parsed.data.attestationIds,
    });
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
