import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';

export class ZhUsernamePasswordError extends Error {
  constructor(
    public readonly code:
      | 'ZH_AUTHENTICATION_FAILED'
      | 'ZH_REGISTRATION_FAILED'
      | 'ZH_AUTH_UNAVAILABLE'
      | 'ZH_RECOVERY_FAILED',
    public readonly status: 400 | 401 | 403 | 503,
  ) {
    super(code);
    this.name = 'ZhUsernamePasswordError';
  }
}

export function zhUsernamePasswordApiError(error: unknown) {
  if (error instanceof ZhUsernamePasswordError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return apiError(error);
}
