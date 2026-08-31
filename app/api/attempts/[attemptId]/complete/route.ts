import { NextResponse } from '@/lib/security/api-response';
import { completeAttemptSchema } from '@/lib/validation/attempt';
import { completeAttempt } from '@/features/learning/server';
import { apiError } from '@/features/auth/api-error';
import { requireUser } from '@/features/auth/server';
import { AttemptExpiredError, AttemptPolicyError } from '@/features/learning/policy-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const { attemptId } = await context.params;
    const body = (await readJsonBody(request)) as { answers?: unknown } | null;
    const parsed = completeAttemptSchema.safeParse({ attemptId, answers: body?.answers });
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireUser();
    return NextResponse.json(await completeAttempt(parsed.data.attemptId, parsed.data.answers));
  } catch (error) {
    if (error instanceof AttemptExpiredError) {
      return NextResponse.json(
        { error: error.code, attempt: error.attempt },
        { status: error.status },
      );
    }
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
