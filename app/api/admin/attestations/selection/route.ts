import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import {
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
    return apiError(error);
  }
}
