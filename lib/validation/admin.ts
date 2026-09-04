import { z } from 'zod';
import { ADMIN_PURGE_BULK_LIMIT } from '@/lib/constants';
import { TEST_EDITOR_LIMITS, TEST_EDITOR_SLUG_PATTERN } from '@/lib/admin-test-editor';
import { contentMetadataDraftSchema } from '@/lib/content/content-metadata';
import { courseSeoSchema } from '@/lib/validation/course';
import { isCourseIconId, type IconId } from '@/lib/course-icons';

export const entityIdSchema = z.string().uuid();
export const adminActionReasonSchema = z.string().trim().min(10).max(500);

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(2).max(60),
  surname: z.string().trim().min(2).max(60),
  job: z.string().trim().min(2).max(120),
  role: z.enum(['participant', 'admin']).default('participant'),
});

export const suspendUserSchema = z.object({
  suspended: z.boolean(),
  reason: adminActionReasonSchema,
});

export const outboxRetrySchema = z.object({ reason: adminActionReasonSchema });

export const purgeUsersSchema = z
  .object({
    userIds: z
      .array(z.string().uuid())
      .min(1)
      .max(ADMIN_PURGE_BULK_LIMIT)
      .refine((values) => new Set(values).size === values.length, 'DUPLICATE_TARGET_IDS'),
    reason: adminActionReasonSchema,
    confirmation: z.literal('УДАЛИТЬ'),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

const productRoleSchema = z.enum(['participant', 'admin']);

export const operatorRoleByEmailSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: productRoleSchema,
    reason: adminActionReasonSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const operatorRoleByIdSchema = z
  .object({
    userId: z.string().uuid(),
    role: productRoleSchema,
    reason: adminActionReasonSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const learningHistoryDeleteSchema = z
  .object({
    reason: adminActionReasonSchema,
    confirmation: z.literal('УДАЛИТЬ'),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const prepareCourseCatalogBatchSchema = z
  .object({
    testIds: z.array(z.string().uuid()).length(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.testIds).size !== value.testIds.length) {
      context.addIssue({ code: 'custom', path: ['testIds'], message: 'duplicateCourseIds' });
    }
  });

export const activateCourseCatalogBatchSchema = z
  .object({
    batchId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const courseCatalogMaintenanceSchema = z.object({ enabled: z.boolean() }).strict();

const stableIdSchema = z.string().uuid();
const draftTestOptionSchema = z
  .object({ id: stableIdSchema, text: z.string().trim().max(500) })
  .strict();
const testOptionSchema = draftTestOptionSchema.extend({ text: z.string().trim().min(1).max(500) });

export const testQuestionSchema = z
  .object({
    id: stableIdSchema,
    text: z
      .string()
      .trim()
      .min(TEST_EDITOR_LIMITS.questionTextMin)
      .max(TEST_EDITOR_LIMITS.questionTextMax),
    options: z.array(testOptionSchema).length(TEST_EDITOR_LIMITS.optionCount),
    correctOptionId: stableIdSchema,
    explanation: z.string().trim().max(TEST_EDITOR_LIMITS.explanationMax).default(''),
  })
  .strict();

const draftTestQuestionSchema = z
  .object({
    id: stableIdSchema,
    text: z.string().trim().max(TEST_EDITOR_LIMITS.questionTextMax),
    options: z.array(draftTestOptionSchema).max(TEST_EDITOR_LIMITS.optionCount),
    correctOptionId: stableIdSchema,
    explanation: z.string().trim().max(TEST_EDITOR_LIMITS.explanationMax).default(''),
  })
  .strict();

export const testVariantSchema = z
  .object({
    id: stableIdSchema,
    variantNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    questions: z.array(testQuestionSchema).length(TEST_EDITOR_LIMITS.questionCount),
  })
  .strict();

/**
 * Shape returned by `public.read_course_question_bank_v4`. The database emits it
 * only when its own validator accepts the bank, so the editor never has to
 * guess a missing correct option or pad a short variant.
 */
export const courseQuestionBankSchema = z
  .array(testVariantSchema)
  .length(TEST_EDITOR_LIMITS.variantCount);

const draftTestVariantSchema = z
  .object({
    id: stableIdSchema,
    variantNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    questions: z.array(draftTestQuestionSchema).max(TEST_EDITOR_LIMITS.questionCount),
  })
  .strict();

export const saveTestSchema = z
  .object({
    id: z.string().uuid().nullable().optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(TEST_EDITOR_SLUG_PATTERN)
      .max(TEST_EDITOR_LIMITS.slugMax),
    title: z.string().trim().min(TEST_EDITOR_LIMITS.titleMin).max(TEST_EDITOR_LIMITS.titleMax),
    description: z.string().trim().max(TEST_EDITOR_LIMITS.descriptionMax).default(''),
    icon: z
      .string()
      .trim()
      .max(40)
      .refine(isCourseIconId, 'Выберите иконку из каталога.')
      .transform((value) => value as IconId),
    displayOrder: z.number().int().min(1).max(TEST_EDITOR_LIMITS.displayOrderMax),
    presentationId: z.string().uuid().nullable(),
    draftVersion: z.number().int().positive().nullable().optional(),
    seo: z.unknown(),
    durationMinutes: z
      .number()
      .int()
      .min(TEST_EDITOR_LIMITS.durationMin)
      .max(TEST_EDITOR_LIMITS.durationMax)
      .default(15),
    passScore: z.number().int().min(1).max(TEST_EDITOR_LIMITS.questionCount).default(7),
    attemptsPerCalendarDay: z
      .number()
      .int()
      .min(TEST_EDITOR_LIMITS.attemptsPerDayMin)
      .max(TEST_EDITOR_LIMITS.attemptsPerDayMax)
      .default(8),
    attemptResetTimezone: z.literal('Asia/Oral').default('Asia/Oral'),
    questionVariants: z.array(draftTestVariantSchema).max(TEST_EDITOR_LIMITS.variantCount),
    publish: z.boolean().default(false),
    ...contentMetadataDraftSchema.shape,
  })
  .strict()
  .superRefine((value, context) => {
    const variantNumbers = new Set(value.questionVariants.map((variant) => variant.variantNumber));
    if (variantNumbers.size !== TEST_EDITOR_LIMITS.variantCount) {
      context.addIssue({ code: 'custom', path: ['questionVariants'], message: 'variantNumbers' });
    }
    const ids = value.questionVariants.flatMap((variant) => [
      variant.id,
      ...variant.questions.flatMap((question) => [
        question.id,
        ...question.options.map((option) => option.id),
      ]),
    ]);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['questionVariants'], message: 'duplicateIds' });
    }
    value.questionVariants.forEach((variant, variantIndex) => {
      variant.questions.forEach((question, questionIndex) => {
        if (!question.options.some((option) => option.id === question.correctOptionId)) {
          context.addIssue({
            code: 'custom',
            path: ['questionVariants', variantIndex, 'questions', questionIndex, 'correctOptionId'],
            message: 'correctOptionNotFound',
          });
        }
      });
    });
    if (value.publish && !value.presentationId) {
      context.addIssue({
        code: 'custom',
        path: ['presentationId'],
        message: 'presentationRequired',
      });
    }
    if (value.publish && !courseSeoSchema.safeParse(value.seo).success) {
      context.addIssue({ code: 'custom', path: ['seo'], message: 'seoInvalid' });
    }
    if (value.publish) {
      const publishedVariants = z
        .array(testVariantSchema)
        .length(TEST_EDITOR_LIMITS.variantCount)
        .safeParse(value.questionVariants);
      if (!publishedVariants.success) {
        for (const issue of publishedVariants.error.issues) {
          context.addIssue({ ...issue, path: ['questionVariants', ...issue.path] });
        }
      }
    }
  });

export const testStatusSchema = z.object({
  status: z.enum(['draft', 'published']),
});

export const deleteCourseSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export type InviteUserValues = z.infer<typeof inviteUserSchema>;
export type SaveTestValues = z.infer<typeof saveTestSchema>;
