import { NextResponse } from '@/lib/security/api-response';
import { requireUser } from '@/server/auth/session';
import { apiError } from '@/server/auth/api-error';
import { getUserIdentity } from '@/server/identity/verification';

export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(await getUserIdentity());
  } catch (error) {
    return apiError(error);
  }
}
