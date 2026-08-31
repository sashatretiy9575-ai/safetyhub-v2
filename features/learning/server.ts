import 'server-only';

import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getRpcMutationError } from '@/lib/supabase/rpc-mutation-result';
import { normalizeRateLimitError } from '@/lib/security/rate-limit';
import { requireUser } from '@/features/auth/server';
import { invalidateCertificateVerificationCache } from '@/features/certificates/server';
import type { Json } from '@/lib/supabase/types';
import type { AttemptPayload } from './types';
import { AttemptExpiredError, parseAttemptRpcError } from './policy-error';
import { QUIZ_POLICY } from '@/lib/constants';

type UntypedRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: Json;
    error: { message: string; details?: string | null } | null;
  }>;
};

const LEGACY_QUESTION_COUNT = 5;
const SUPPORTED_ATTEMPT_TOTALS = new Set<number>([
  LEGACY_QUESTION_COUNT,
  QUIZ_POLICY.questionCount,
]);

const optionSchema = z.object({ id: z.string().uuid(), text: z.string(), position: z.number() });
const questionSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  position: z.number(),
  selectedOptionId: z.string().uuid().nullable(),
  // Stage A must continue to parse legacy, already-published question banks. The
  // v3 publication RPC remains the strict 3 x 10 x 4 enforcement boundary.
  options: z.array(optionSchema).min(2).max(6),
});
const reviewItemSchema = z.object({
  questionId: z.string().uuid(),
  selectedOptionId: z.string().uuid(),
  correctOptionId: z.string().uuid(),
  isCorrect: z.boolean(),
  explanation: z
    .string()
    .nullable()
    .transform((value) => value ?? ''),
});
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const attemptPayloadSchema = z
  .object({
    attemptId: z.string().uuid(),
    courseId: z.string().uuid(),
    revisionId: z.string().uuid(),
    testSlug: z.string(),
    title: z.string(),
    status: z.enum(['started', 'completed', 'passed', 'failed', 'expired']),
    score: z.number().int().nonnegative().nullable(),
    total: z
      .number()
      .int()
      .refine((value) => SUPPORTED_ATTEMPT_TOTALS.has(value)),
    passed: z.boolean().nullable(),
    certificateId: z.string().uuid().nullable(),
    certificatePendingVerification: z.boolean().default(false),
    durationMinutes: z.number().int().min(1).max(120),
    passScore: z.number().int().min(1).max(QUIZ_POLICY.questionCount),
    startedAt: timestampSchema,
    expiresAt: timestampSchema,
    serverNow: timestampSchema,
    retryAt: timestampSchema.nullable(),
    questions: z.array(questionSchema).min(LEGACY_QUESTION_COUNT).max(QUIZ_POLICY.questionCount),
    review: z.array(reviewItemSchema).max(QUIZ_POLICY.questionCount),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.questions.length !== payload.total) {
      context.addIssue({ code: 'custom', message: 'questionTotal' });
    }
    if (payload.total === QUIZ_POLICY.questionCount) {
      for (const question of payload.questions) {
        if (question.options.length !== 4) {
          context.addIssue({ code: 'custom', message: 'optionTotal' });
          break;
        }
      }
    }
    if (payload.passScore > payload.total) {
      context.addIssue({ code: 'custom', message: 'passScore' });
    }
    if (payload.score !== null && payload.score > payload.total) {
      context.addIssue({ code: 'custom', message: 'score' });
    }
    if (payload.status === 'passed' && payload.review.length !== payload.total) {
      context.addIssue({ code: 'custom', message: 'passedReview' });
    }
    if ((payload.status === 'passed' || payload.status === 'failed') && payload.score === null) {
      context.addIssue({ code: 'custom', message: 'completedScore' });
    }
    if (payload.status !== 'passed' && payload.review.length !== 0) {
      context.addIssue({ code: 'custom', message: 'prematureReview' });
    }
    if (
      payload.status !== 'started' &&
      payload.questions.some((question) => question.selectedOptionId !== null)
    ) {
      context.addIssue({ code: 'custom', message: 'completedDraftLeak' });
    }
  });
function parseRpcPayload(value: Json): AttemptPayload {
  const parsed = attemptPayloadSchema.safeParse(value);
  if (!parsed.success) throw new Error('INVALID_ATTEMPT_PAYLOAD');
  return parsed.data;
}

function parseAttemptMutationPayload(value: Json): AttemptPayload {
  const envelopeError = getRpcMutationError(value);
  if (envelopeError) throw parseAttemptRpcError(envelopeError);
  return parseRpcPayload(value);
}

export async function startAttempt(testSlug: string, startNew = false) {
  await requireUser({ enforceLegal: true });
  const client = (await createClient()) as unknown as UntypedRpcClient;
  const { data, error } = await client.rpc(
    startNew ? 'start_test_attempt' : 'resume_test_attempt',
    {
      p_test_slug: testSlug,
    },
  );
  if (error) {
    if (error.message.includes('RATE_LIMITED:')) normalizeRateLimitError(error);
    throw parseAttemptRpcError(error);
  }
  return parseAttemptMutationPayload(data);
}

export async function getAttempt(attemptId: string) {
  await requireUser({ enforceLegal: true });
  const client = (await createClient()) as unknown as UntypedRpcClient;
  const { data, error } = await client.rpc('get_test_attempt', {
    p_attempt_id: attemptId,
  });
  if (error) throw parseAttemptRpcError(error);
  return parseRpcPayload(data);
}

export async function completeAttempt(
  attemptId: string,
  answers: Array<{ questionId: string; optionId: string }>,
) {
  await requireUser({ enforceLegal: true });
  const client = (await createClient()) as unknown as UntypedRpcClient;
  const { data, error } = await client.rpc('complete_test_attempt', {
    p_attempt_id: attemptId,
    p_answers: answers as unknown as Json,
  });
  if (error) {
    if (error.message.includes('RATE_LIMITED:')) normalizeRateLimitError(error);
    throw parseAttemptRpcError(error);
  }
  const payload = parseAttemptMutationPayload(data);
  if (payload.status === 'expired') throw new AttemptExpiredError(payload);
  // A strict score improvement may atomically replace an active certificate.
  invalidateCertificateVerificationCache();
  return payload;
}
