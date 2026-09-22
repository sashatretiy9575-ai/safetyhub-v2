import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { ELECTRICAL_GROUPS, ELECTRICAL_VOLTAGES } from '@/lib/pdf/electrical';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { savePersonElectrical } from '@/server/certificates/document-people';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const schema = z
  .object({
    userId: z.string().uuid(),
    courseSlug: z.string().min(1).max(160),
    group: z.enum(ELECTRICAL_GROUPS).nullable(),
    voltage: z.enum(ELECTRICAL_VOLTAGES).nullable(),
  })
  .strict();

/** The group of admission of one person; null leaves them on the course's own. */
export async function PUT(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('certificate.issue');
    await consumeAdminMutationQuota(
      'admin.attestation.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const parsed = schema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await savePersonElectrical(
      parsed.data.userId,
      parsed.data.courseSlug,
      parsed.data.group,
      parsed.data.voltage,
    );
    return NextResponse.json({ group: parsed.data.group, voltage: parsed.data.voltage });
  } catch (error) {
    return apiError(error);
  }
}
