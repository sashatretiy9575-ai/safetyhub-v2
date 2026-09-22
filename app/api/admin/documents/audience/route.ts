import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { savePersonAudience } from '@/server/certificates/document-people';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const schema = z
  .object({ userId: z.string().uuid(), audience: z.enum(['itr', 'worker']).nullable() })
  .strict();

/** «ИТР» or «Рабочий» for one person; null gives the choice back to the position. */
export async function PUT(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('certificate.issue');
    await consumeAdminMutationQuota(
      'admin.attestation.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const parsed = schema.safeParse(await readJsonBody(request, 1024));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await savePersonAudience(parsed.data.userId, parsed.data.audience);
    return NextResponse.json({ audience: parsed.data.audience });
  } catch (error) {
    return apiError(error);
  }
}
