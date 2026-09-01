import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { ZhWebAuthnError } from '@/features/auth/zh-webauthn-server';

export function zhWebAuthnApiError(error: unknown) {
  if (error instanceof ZhWebAuthnError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return apiError(error);
}
