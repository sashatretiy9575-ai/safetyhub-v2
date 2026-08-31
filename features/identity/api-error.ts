import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';

export function identityApiError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('IDENTITY_NOT_VERIFIED')) {
    return NextResponse.json({ error: 'IDENTITY_NOT_VERIFIED' }, { status: 409 });
  }
  return apiError(error);
}
