import * as z from 'zod';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { previewOrganizationMerge } from '@/features/admin/organizations';
import { readJsonBody } from '@/lib/security/request-body';
import { NextResponse } from '@/lib/security/api-response';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

const schema = z
  .object({
    sourceIds: z.array(z.string().uuid()).min(1).max(100),
    targetId: z.string().uuid(),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    // The preview resolves similarity across the whole organization directory,
    // which is as expensive as any metered administrative read.
    await consumeCoarseQuota('admin.read.query', requestSecurityMetadata(request).ipHash);
    const parsed = schema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    return NextResponse.json(
      await previewOrganizationMerge(parsed.data.sourceIds, parsed.data.targetId),
    );
  } catch (error) {
    return apiError(error);
  }
}
