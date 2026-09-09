import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import {
  ADMIN_ATTESTATION_BULK_LIMIT,
  adminAttestationFilterInputSchema,
  resolveAdminAttestationSelection,
} from '@/features/admin/attestations';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
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
