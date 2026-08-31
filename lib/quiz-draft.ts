export type QuizAnswer = Readonly<{ questionId: string; optionId: string }>;

export type QuizDraftQuestion = Readonly<{
  id: string;
  selectedOptionId: string | null;
  options: ReadonlyArray<Readonly<{ id: string }>>;
}>;

export type LocalQuizDraft = Readonly<{
  attemptId: string;
  currentIndex: number;
  // The unfinished draft is intentionally device-local. The server receives
  // the complete answer set once, when the learner confirms submission.
  answers: QuizAnswer[];
}>;

export type RestoredQuizDraft = Readonly<{
  answers: QuizAnswer[];
  currentIndex: number;
}>;

const DRAFT_PREFIX = 'safetyhub:quiz-draft:v2:';

export function quizDraftStorageKey(attemptId: string) {
  return `${DRAFT_PREFIX}${attemptId}`;
}

function isQuizAnswer(value: unknown): value is QuizAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'questionId' in value &&
    typeof value.questionId === 'string' &&
    'optionId' in value &&
    typeof value.optionId === 'string'
  );
}

export function parseQuizDraft(raw: string | null, attemptId: string): LocalQuizDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalQuizDraft>;
    if (
      value.attemptId !== attemptId ||
      !Number.isInteger(value.currentIndex) ||
      !Array.isArray(value.answers) ||
      !value.answers.every(isQuizAnswer)
    ) {
      return null;
    }
    return value as LocalQuizDraft;
  } catch {
    return null;
  }
}

export function readQuizDraft(storage: Storage, attemptId: string) {
  try {
    return parseQuizDraft(storage.getItem(quizDraftStorageKey(attemptId)), attemptId);
  } catch {
    return null;
  }
}

export function writeQuizDraft(
  storage: Storage,
  attemptId: string,
  answers: ReadonlyArray<QuizAnswer>,
  currentIndex: number,
) {
  const value: LocalQuizDraft = {
    attemptId,
    currentIndex,
    answers: [...new Map(answers.map((answer) => [answer.questionId, answer])).values()],
  };
  try {
    storage.setItem(quizDraftStorageKey(attemptId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearQuizDraft(storage: Storage, attemptId: string) {
  try {
    storage.removeItem(quizDraftStorageKey(attemptId));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

export function restoreQuizDraft(
  attemptId: string,
  questions: ReadonlyArray<QuizDraftQuestion>,
  localDraft: LocalQuizDraft | null,
): RestoredQuizDraft {
  const validOptions = new Map(
    questions.map((question) => [
      question.id,
      new Set(question.options.map((option) => option.id)),
    ]),
  );
  const merged = new Map<string, QuizAnswer>();

  for (const question of questions) {
    if (
      question.selectedOptionId &&
      validOptions.get(question.id)?.has(question.selectedOptionId)
    ) {
      merged.set(question.id, {
        questionId: question.id,
        optionId: question.selectedOptionId,
      });
    }
  }

  if (localDraft?.attemptId === attemptId) {
    // A local choice overrides an older server projection from a deployment
    // that still persisted per-question answers.
    for (const answer of localDraft.answers) {
      if (validOptions.get(answer.questionId)?.has(answer.optionId)) {
        merged.set(answer.questionId, answer);
      }
    }
  }

  const answers = questions.flatMap((question) => {
    const answer = merged.get(question.id);
    return answer ? [answer] : [];
  });
  const firstUnanswered = questions.findIndex((question) => !merged.has(question.id));
  const fallbackIndex =
    firstUnanswered === -1 ? Math.max(0, questions.length - 1) : firstUnanswered;
  const storedIndex = localDraft?.attemptId === attemptId ? localDraft.currentIndex : fallbackIndex;
  const currentIndex =
    Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < questions.length
      ? storedIndex
      : fallbackIndex;

  return {
    answers,
    currentIndex,
  };
}
