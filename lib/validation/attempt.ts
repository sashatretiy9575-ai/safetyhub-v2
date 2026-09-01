import { z } from 'zod';
import { QUIZ_POLICY } from '@/lib/constants';

const LEGACY_QUESTION_COUNT = 5;
const isSupportedAttemptLength = (length: number) =>
  length === LEGACY_QUESTION_COUNT || length === QUIZ_POLICY.questionCount;

export const createAttemptSchema = z.object({
  testSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  startNew: z.boolean().optional().default(false),
  locale: z.enum(['ru', 'kk', 'en', 'zh']).default('ru'),
});
export type CreateAttemptValues = z.infer<typeof createAttemptSchema>;

export const completeAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid(),
        optionId: z.string().uuid(),
      }),
    )
    .min(LEGACY_QUESTION_COUNT)
    .max(QUIZ_POLICY.questionCount)
    .refine((answers) => isSupportedAttemptLength(answers.length), {
      message: 'unsupportedQuestionCount',
    })
    .refine(
      (answers) => new Set(answers.map((answer) => answer.questionId)).size === answers.length,
      {
        message: 'duplicateQuestions',
      },
    ),
});
export type CompleteAttemptValues = z.infer<typeof completeAttemptSchema>;
