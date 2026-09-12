import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import {
  ADMIN_ATTESTATION_BULK_LIMIT,
  adminAttestationFilterInputSchema,
  resolveAdminAttestationSelection,
} from '@/server/admin/attestations';
import { readJsonBody } from '@/lib/security/request-body';
import { consumeCoarseQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    // The resolver runs an arbitrary filter across the whole register, so it is
    // metered like any other expensive administrative read.
    await consumeCoarseQuota('admin.read.query', requestSecurityMetadata(request).ipHash);
    const parsed = adminAttestationFilterInputSchema.safeParse(
      await readJsonBody(request),
    );
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(await resolveAdminAttestationSelection(parsed.data));
  } catch (error) {
    // The database refuses a filter matching more rows than one bulk operation
    // may carry. That is the operator's filter being too broad, not a server
    // fault: as a 500 it produced an alarming "something went wrong" and no way
    // to act. The mapping is local because SQLSTATE 54000 is raised by eight
    // different conditions across the schema.
    if (error instanceof Error && error.message.includes('ATTESTATION_SELECTION_TOO_LARGE')) {
      return NextResponse.json(
        { error: 'ATTESTATION_SELECTION_TOO_LARGE', limit: ADMIN_ATTESTATION_BULK_LIMIT },
        { status: 409 },
      );
    }
    return apiError(error);
  }
}
