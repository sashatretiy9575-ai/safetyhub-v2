import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { savePersonNote } from '@/server/certificates/document-people';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const schema = z
  .object({
    userId: z.string().uuid(),
    courseSlug: z.string().min(1).max(160),
    notes: z.string().max(500),
  })
  .strict();

/** «Примечание» of one person in one course; it is printed on the protocols issued after it. */
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
    await savePersonNote(parsed.data.userId, parsed.data.courseSlug, parsed.data.notes);
    return NextResponse.json({ notes: parsed.data.notes.trim() });
  } catch (error) {
    return apiError(error);
  }
}
