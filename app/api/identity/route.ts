import { NextResponse } from '@/lib/security/api-response';
import { requireUser } from '@/features/auth/server';
import { apiError } from '@/features/auth/api-error';
import { getUserIdentity } from '@/features/identity/server';

export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(await getUserIdentity());
  } catch (error) {
    return apiError(error);
  }
}
