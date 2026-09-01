import { NextResponse } from '@/lib/security/api-response';
import { createAttemptSchema } from '@/lib/validation/attempt';
import { startAttempt } from '@/features/learning/server';
import { apiError } from '@/features/auth/api-error';
import { AttemptPolicyError } from '@/features/learning/policy-error';
import { requireUser } from '@/features/auth/server';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = createAttemptSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireUser();
    return NextResponse.json(
      await startAttempt(parsed.data.testSlug, parsed.data.startNew, parsed.data.locale),
    );
  } catch (error) {
    if (error instanceof AttemptPolicyError) {
      return NextResponse.json(
        { error: error.code, retryAt: error.retryAt },
        {
          status: error.status,
          headers: error.retryAfterSeconds
            ? { 'Retry-After': String(error.retryAfterSeconds) }
            : undefined,
        },
      );
    }
    return apiError(error);
  }
}
