/** Shared browser/server contract for the administrative course editor. */
import { contentMetadataSchema } from './content/content-metadata.ts';
import { courseSeoSchema } from './validation/course.ts';
import { defaultContentSeo, type ContentSeo } from './validation/content-seo.ts';
import { isCourseIconId } from './course-icons.ts';

export const TEST_EDITOR_LIMITS = Object.freeze({
  variantCount: 3,
  questionCount: 10,
  optionCount: 4,
  titleMin: 3,
  titleMax: 180,
  slugMax: 80,
  descriptionMax: 1_000,
  displayOrderMin: 1,
  displayOrderMax: 10_000,
  durationMin: 1,
  durationMax: 120,
  passScoreMin: 1,
  attemptsPerDayMin: 1,
  attemptsPerDayMax: 50,
  questionTextMin: 3,
  questionTextMax: 1_000,
  optionTextMin: 1,
  optionTextMax: 500,
  explanationMax: 2_000,
  presentationMaxBytes: 25 * 1024 * 1024,
  presentationMaxPages: 200,
});

export const TEST_EDITOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TestEditorQuestion = Readonly<{
  id: string;
  text: string;
  options: ReadonlyArray<Readonly<{ id: string; text: string }>>;
  correctOptionId: string;
  explanation: string;
}>;

export type TestEditorVariant = Readonly<{
  id: string;
  variantNumber: 1 | 2 | 3;
  questions: ReadonlyArray<TestEditorQuestion>;
}>;

export type TestEditorPresentation = Readonly<{
  id: string;
  pageCount: number;
  sha256: string;
  byteSize: number;
  status: 'staging' | 'validating' | 'ready' | 'rejected' | 'retired';
}>;

export type TestEditorRevisionSummary = Readonly<{
  id: string;
  version: number;
  publishedAt: string;
  contentHash: string;
  presentationId: string | null;
  current: boolean;
}>;

/**
 * In-memory input for a newly authored course revision. It is deliberately
 * not a persisted browser draft: existing answer keys are never restored to a
 * client, while a content manager may submit a fresh question set once.
 */
export type TestEditorInput = Readonly<{
  id?: string;
  slug: string;
  title: string;
  description: string;
  icon?: string;
  displayOrder: number;
  durationMinutes: number;
  passScore: number;
  attemptsPerCalendarDay: number;
  attemptResetTimezone: string;
  presentationId: string | null;
  presentation: TestEditorPresentation | null;
  draftVersion?: number;
  publicationState?: 'never_published' | 'draft' | 'published' | 'published_with_draft_changes';
  contentHash?: string;
  seo?: ContentSeo;
  jurisdiction?: string;
  effectiveDate?: string;
  sources?: ReadonlyArray<Readonly<{ title: string; url: string }>>;
  status?: 'draft' | 'published';
  questionVariants: ReadonlyArray<TestEditorVariant>;
  revisionHistory?: ReadonlyArray<TestEditorRevisionSummary>;
}>;

export type TestEditorValidation = Readonly<{
  valid: boolean;
  fieldErrors: Readonly<Record<string, string>>;
  fieldWarnings: Readonly<Record<string, string>>;
  questionComplete: ReadonlyArray<ReadonlyArray<boolean>>;
  completedCount: number;
  firstInvalidFieldId: string | null;
  firstInvalidVariantIndex: number | null;
  firstInvalidQuestionIndex: number | null;
}>;

export function serializeTestEditorPayload(test: TestEditorInput) {
  const { revisionHistory: _revisionHistory, ...editable } = test;
  return JSON.stringify(editable);
}

function addError(errors: Record<string, string>, fieldId: string, message: string) {
  if (!errors[fieldId]) errors[fieldId] = message;
}

function normalizedEditorText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function duplicateTexts(values: ReadonlyArray<string>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = normalizedEditorText(value);
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function validPresentation(presentation: TestEditorPresentation | null) {
  return Boolean(
    presentation &&
    UUID_PATTERN.test(presentation.id) &&
    presentation.status === 'ready' &&
    presentation.pageCount >= 1 &&
    presentation.pageCount <= TEST_EDITOR_LIMITS.presentationMaxPages &&
    presentation.byteSize > 0 &&
    presentation.byteSize <= TEST_EDITOR_LIMITS.presentationMaxBytes &&
    /^[0-9a-f]{64}$/u.test(presentation.sha256),
  );
}

export function validateTestEditor(
  test: TestEditorInput,
  options: { publish?: boolean } = { publish: true },
): TestEditorValidation {
  const publish = options.publish ?? true;
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const title = test.title.trim();
  if (title.length < TEST_EDITOR_LIMITS.titleMin) {
    addError(errors, 'test-title', 'Введите название — минимум 3 символа.');
  } else if (title.length > TEST_EDITOR_LIMITS.titleMax) {
    addError(errors, 'test-title', 'Сократите название до 180 символов.');
  }
  const normalizedSlug = test.slug.trim().toLowerCase();
  if (!TEST_EDITOR_SLUG_PATTERN.test(normalizedSlug)) {
    addError(errors, 'test-slug', 'Используйте латинские буквы, цифры и дефисы.');
  } else if (normalizedSlug.length > TEST_EDITOR_LIMITS.slugMax) {
    addError(errors, 'test-slug', 'Сократите slug до 80 символов.');
  }
  if (test.description.trim().length > TEST_EDITOR_LIMITS.descriptionMax) {
    addError(errors, 'test-description', 'Сократите описание до 1000 символов.');
  }
  if (!isCourseIconId(test.icon ?? 'shield-check')) {
    addError(errors, 'test-icon', 'Выберите корректную иконку курса.');
  }
  if (!Number.isInteger(test.displayOrder) || test.displayOrder < 1 || test.displayOrder > 10_000) {
    addError(errors, 'test-display-order', 'Укажите положительный порядок курса.');
  }
  if (
    !Number.isInteger(test.durationMinutes) ||
    test.durationMinutes < 1 ||
    test.durationMinutes > 120
  ) {
    addError(errors, 'test-duration', 'Укажите целое число от 1 до 120.');
  }
  if (!Number.isInteger(test.passScore) || test.passScore < 1 || test.passScore > 10) {
    addError(errors, 'test-pass-score', 'Проходной балл должен быть от 1 до 10.');
  }
  if (
    !Number.isInteger(test.attemptsPerCalendarDay) ||
    test.attemptsPerCalendarDay < 1 ||
    test.attemptsPerCalendarDay > 50
  ) {
    addError(errors, 'test-attempt-limit', 'Укажите целое число от 1 до 50.');
  }
  if (test.attemptResetTimezone !== 'Asia/Oral') {
    addError(errors, 'test-timezone', 'Для каталога используется часовой пояс Asia/Oral.');
  }
  if (publish && (!test.presentationId || !validPresentation(test.presentation))) {
    addError(errors, 'test-presentation', 'Загрузите и дождитесь проверки PDF-презентации.');
  } else if (test.presentation && test.presentation.id !== test.presentationId) {
    addError(errors, 'test-presentation', 'Выбрана несогласованная версия презентации.');
  }
  if (
    publish &&
    !courseSeoSchema.safeParse(test.seo ?? defaultContentSeo(test.title, test.description)).success
  ) {
    addError(errors, 'test-seo', 'Заполните SEO-заголовок и описание курса.');
  }
  const metadata = contentMetadataSchema.safeParse({
    jurisdiction: test.jurisdiction ?? '',
    effectiveDate: test.effectiveDate ?? '',
    sources: test.sources ?? [],
  });
  if (!metadata.success) {
    for (const issue of metadata.error.issues) {
      const [field, index, nested] = issue.path;
      const fieldId =
        field === 'sources' && typeof index === 'number'
          ? `test-source-${index}-${nested === 'url' ? 'url' : 'title'}`
          : `test-${String(field).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      addError(errors, fieldId, issue.message);
    }
  }

  if (publish && test.questionVariants.length !== TEST_EDITOR_LIMITS.variantCount) {
    addError(errors, 'variant-tab-0', 'Курс должен содержать ровно 3 варианта теста.');
  }
  const allIds = new Set<string>();
  const questionComplete = Array.from(
    { length: TEST_EDITOR_LIMITS.variantCount },
    (_, variantIndex) => {
      const variant = test.questionVariants[variantIndex];
      if (publish && (!variant || variant.variantNumber !== variantIndex + 1)) {
        addError(
          errors,
          `variant-tab-${variantIndex}`,
          `Неверная структура варианта ${variantIndex + 1}.`,
        );
      }
      if (publish && variant?.questions.length !== TEST_EDITOR_LIMITS.questionCount) {
        addError(
          errors,
          `variant-${variantIndex}-question-0`,
          'В варианте должно быть ровно 10 вопросов.',
        );
      }
      if (variant && (!UUID_PATTERN.test(variant.id) || allIds.has(variant.id))) {
        addError(
          errors,
          `variant-tab-${variantIndex}`,
          'Вариант имеет неверный или повторяющийся идентификатор.',
        );
      }
      if (variant) allIds.add(variant.id);
      const repeatedQuestions = duplicateTexts(
        variant?.questions.map((question) => question.text) ?? [],
      );
      return Array.from({ length: TEST_EDITOR_LIMITS.questionCount }, (_, questionIndex) => {
        const question = variant?.questions[questionIndex];
        const prefix = `variant-${variantIndex}-question-${questionIndex}`;
        if (!question) return false;
        let complete = true;
        if (!UUID_PATTERN.test(question.id) || allIds.has(question.id)) {
          addError(errors, prefix, 'Вопрос имеет неверный или повторяющийся идентификатор.');
          complete = false;
        }
        allIds.add(question.id);
        if (question.text.trim().length < TEST_EDITOR_LIMITS.questionTextMin) {
          if (publish) addError(errors, prefix, 'Введите текст вопроса — минимум 3 символа.');
          complete = false;
        } else if (question.text.trim().length > TEST_EDITOR_LIMITS.questionTextMax) {
          addError(errors, prefix, 'Сократите вопрос до 1000 символов.');
          complete = false;
        }
        if (repeatedQuestions.has(normalizedEditorText(question.text))) {
          warnings[prefix] = 'Этот текст вопроса повторяется в текущем варианте.';
        }
        if (publish && question.options.length !== TEST_EDITOR_LIMITS.optionCount) {
          addError(errors, `${prefix}-option-0`, 'Добавьте ровно 4 варианта ответа.');
          complete = false;
        }
        const repeatedOptions = duplicateTexts(question.options.map((option) => option.text));
        question.options.forEach((option, optionIndex) => {
          const fieldId = `${prefix}-option-${optionIndex}`;
          if (!UUID_PATTERN.test(option.id) || allIds.has(option.id)) {
            addError(errors, fieldId, 'Ответ имеет неверный или повторяющийся идентификатор.');
            complete = false;
          }
          allIds.add(option.id);
          const length = option.text.trim().length;
          if (length < 1) {
            if (publish) addError(errors, fieldId, 'Введите текст варианта.');
            complete = false;
          } else if (length > TEST_EDITOR_LIMITS.optionTextMax) {
            addError(errors, fieldId, 'Сократите вариант до 500 символов.');
            complete = false;
          }
          if (repeatedOptions.has(normalizedEditorText(option.text))) {
            warnings[fieldId] = 'Этот вариант ответа повторяется в вопросе.';
          }
        });
        if (
          !UUID_PATTERN.test(question.correctOptionId) ||
          !question.options.some((option) => option.id === question.correctOptionId)
        ) {
          if (publish) addError(errors, `${prefix}-correct`, 'Выберите один правильный ответ.');
          complete = false;
        }
        if (question.explanation.trim().length > TEST_EDITOR_LIMITS.explanationMax) {
          addError(errors, `${prefix}-explanation`, 'Сократите пояснение до 2000 символов.');
          complete = false;
        }
        return complete;
      });
    },
  );

  const firstInvalidFieldId = Object.keys(errors)[0] ?? null;
  const match = firstInvalidFieldId?.match(/^variant-(\d+)-question-(\d+)/u);
  return {
    valid: Object.keys(errors).length === 0,
    fieldErrors: errors,
    fieldWarnings: warnings,
    questionComplete,
    completedCount: questionComplete.flat().filter(Boolean).length,
    firstInvalidFieldId,
    firstInvalidVariantIndex: match ? Number(match[1]) : null,
    firstInvalidQuestionIndex: match ? Number(match[2]) : null,
  };
}
