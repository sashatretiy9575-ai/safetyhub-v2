import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { getSiteUrl, requireCapability } from '@/server/auth/session';
import {
  certificateExportResultSchema,
  createCertificateExportMetadata,
} from '@/server/admin/certificate-export-archive';
import {
  CERTIFICATE_EXPORT_METADATA_MAX_BYTES,
  createBoundedCertificateMetadataResponse,
} from '@/server/certificates/metadata-response';
import { createClient } from '@/server/supabase/server';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeCoarseQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { NextResponse } from '@/lib/security/api-response';
import { CERTIFICATE_EXPORT_SYNC_LIMIT } from '@/lib/constants';

export const runtime = 'nodejs';
// Heavier than an ordinary API call: the default function budget cuts it off.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const exportSchema = z
  .object({
    attestationIds: z
      .array(z.string().uuid())
      .min(1)
      .max(CERTIFICATE_EXPORT_SYNC_LIMIT)
      .refine((values) => new Set(values).size === values.length, 'DUPLICATE_ATTESTATION_IDS'),
  })
  .strict();

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
    await requireCapability('results.export');
    const parsed = exportSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('certificate.read');
    await consumeCoarseQuota('certificate.export', requestSecurityMetadata(request).ipHash);

    const client = (await createClient()) as unknown as RpcClient;
    const response = await client.rpc('resolve_certificate_export', {
      p_attestation_ids: parsed.data.attestationIds,
    });
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
