import { NextResponse } from '@/lib/security/api-response';
import * as z from 'zod';
import { getAttempt } from '@/server/learning/attempts';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { AttemptPolicyError } from '@/server/learning/policy-error';

const paramsSchema = z.object({ attemptId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    return NextResponse.json(await getAttempt(parsed.data.attemptId));
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
