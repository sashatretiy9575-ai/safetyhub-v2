import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { mergeOrganizations } from '@/server/admin/organizations';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { NextResponse } from '@/lib/security/api-response';

const schema = z
  .object({
    idempotencyKey: z.string().uuid(),
    sourceIds: z.array(z.string().uuid()).min(1).max(100),
    targetId: z.string().uuid(),
    reissueCertificates: z.boolean(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireCapability('identity.manage');
    await consumeAdminMutationQuota(
      'admin.attestation.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(await mergeOrganizations(parsed.data));
  } catch (error) {
    return apiError(error);
  }
}
