import { NextResponse } from '@/lib/security/api-response';
import { getAdminAttestationFilters } from '@/server/admin/attestations';
import { apiError } from '@/server/auth/api-error';

export async function GET() {
  try {
    return NextResponse.json(await getAdminAttestationFilters(), {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
