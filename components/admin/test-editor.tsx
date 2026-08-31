'use client';

import { ArrowDown, ArrowUp } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminTestQuestion,
  AdminTestVariant,
  TestEditorPayload,
} from '@/features/admin/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  clearTestEditorDraft,
  readTestEditorDraft,
  serializeTestEditorPayload,
  TEST_EDITOR_LIMITS,
  validateTestEditor,
  writeTestEditorDraft,
  type TestEditorDraftPayload,
} from '@/lib/admin-test-editor';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { defaultContentSeo } from '@/lib/validation/content-seo';
import { resolveCourseIcon } from '@/lib/course-icons';
import { IconPicker } from '@/components/admin/icon-picker';
import { ContentSeoEditor } from '@/components/admin/content-seo-editor';
import { CoursePresentationInput } from '@/components/admin/course-presentation-input';
import { EditorActionBar } from '@/components/admin/editor-action-bar';
import { EditorShell } from '@/components/admin/editor-shell';
import { useUnsavedChangesGuard } from '@/components/admin/use-unsaved-changes-guard';
import { cn, formatDateTime } from '@/lib/utils';

type PublicationState = NonNullable<TestEditorPayload['publicationState']>;
const AUTOSAVE_DELAY_MS = 800;
const PUBLICATION_LABEL: Record<PublicationState, string> = {
  never_published: 'Ещё не публиковался',
  draft: 'Снят с публикации',
  published: 'Опубликован',
  published_with_draft_changes: 'Опубликован',
};

function newQuestion(): AdminTestQuestion {
  const options = Array.from({ length: TEST_EDITOR_LIMITS.optionCount }, () => ({
    id: crypto.randomUUID(),
    text: '',
  }));
  return {
    id: crypto.randomUUID(),
    text: '',
    options,
    correctOptionId: options[0]!.id,
    explanation: '',
  };
}

function newVariants(): [AdminTestVariant, AdminTestVariant, AdminTestVariant] {
  return [1, 2, 3].map((variantNumber) => ({
    id: crypto.randomUUID(),
    variantNumber: variantNumber as 1 | 2 | 3,
    questions: Array.from({ length: TEST_EDITOR_LIMITS.questionCount }, newQuestion),
  })) as [AdminTestVariant, AdminTestVariant, AdminTestVariant];
}

const emptyTest = (): TestEditorPayload => ({
  slug: '',
  title: '',
  description: '',
  icon: 'shield-check',
  displayOrder: 1,
  durationMinutes: 15,
  passScore: 7,
  attemptsPerCalendarDay: 8,
  attemptResetTimezone: 'Asia/Oral',
  presentationId: null,
  presentation: null,
  jurisdiction: 'Республика Казахстан',
  effectiveDate: '',
  sources: [],
  seo: defaultContentSeo(),
  questionVariants: newVariants(),
  revisionHistory: [],
});

function clonePayload(value: TestEditorDraftPayload): TestEditorPayload {
  return {
    ...(value.id ? { id: value.id } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(value.draftVersion ? { draftVersion: value.draftVersion } : {}),
    ...(value.publicationState ? { publicationState: value.publicationState } : {}),
    ...(value.contentHash ? { contentHash: value.contentHash } : {}),
    slug: value.slug,
    title: value.title,
    description: value.description,
    icon: resolveCourseIcon(value.icon).id,
    displayOrder: value.displayOrder,
    durationMinutes: value.durationMinutes,
    passScore: value.passScore,
    attemptsPerCalendarDay: value.attemptsPerCalendarDay,
    attemptResetTimezone: value.attemptResetTimezone,
    presentationId: value.presentationId,
    presentation: value.presentation ? { ...value.presentation } : null,
    jurisdiction: value.jurisdiction ?? '',
    effectiveDate: value.effectiveDate ?? '',
    sources: (value.sources ?? []).map((source) => ({ ...source })),
    seo: { ...(value.seo ?? defaultContentSeo(value.title, value.description)) },
    revisionHistory: (value.revisionHistory ?? []).map((revision) => ({ ...revision })),
    questionVariants: value.questionVariants.map((variant) => ({
      id: variant.id,
      variantNumber: variant.variantNumber,
      questions: variant.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option })),
      })),
    })) as [AdminTestVariant, AdminTestVariant, AdminTestVariant],
  };
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={`${id}-error`} role="alert" className="text-sm text-[var(--color-danger)]">
      {message}
    </p>
  ) : null;
}

function FieldWarning({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={`${id}-warning`} role="status" className="text-sm text-[var(--color-warning)]">
      {message}
    </p>
  ) : null;
}

function formatDraftTime(value: number) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(value);
}

export function TestEditor({ initial }: { initial?: TestEditorPayload }) {
  const router = useRouter();
  const normalizedInitial = useMemo(() => clonePayload(initial ?? emptyTest()), [initial]);
  const editorIdRef = useRef(initial?.id ?? 'new');
  const [course, setCourse] = useState<TestEditorPayload>(normalizedInitial);
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    serializeTestEditorPayload(normalizedInitial),
  );
  const [activeVariant, setActiveVariant] = useState(0);
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftMessage, setDraftMessage] = useState('Локальный черновик включён');

  const snapshot = useMemo(() => serializeTestEditorPayload(course), [course]);
  const initialSnapshot = useMemo(
    () => serializeTestEditorPayload(normalizedInitial),
    [normalizedInitial],
  );
  const dirty = snapshot !== savedSnapshot;
  const approveNavigation = useUnsavedChangesGuard(dirty);
  const validation = useMemo(() => validateTestEditor(course), [course]);
  const draftValidation = useMemo(() => validateTestEditor(course, { publish: false }), [course]);
  const validationMessages = useMemo(
    () => [...new Set(Object.values(validation.fieldErrors))],
    [validation.fieldErrors],
  );
  const validationWarnings = useMemo(
    () => [...new Set(Object.values(validation.fieldWarnings))],
    [validation.fieldWarnings],
  );
  const currentVariant = course.questionVariants[activeVariant];
  const currentQuestion = currentVariant?.questions[activeQuestion];

  useEffect(() => {
    const draft = readTestEditorDraft(window.localStorage, editorIdRef.current);
    if (draft && serializeTestEditorPayload(draft.test) !== initialSnapshot) {
      setCourse({
        ...clonePayload(draft.test),
        revisionHistory: normalizedInitial.revisionHistory,
      });
      setDraftMessage(`Восстановлен локальный черновик · ${formatDraftTime(draft.savedAt)}`);
    }
    setDraftReady(true);
  }, [initialSnapshot, normalizedInitial.revisionHistory]);

  useEffect(() => {
    if (!draftReady) return;
    if (!dirty) {
      clearTestEditorDraft(window.localStorage, editorIdRef.current);
      return;
    }
    setDraftMessage('Сохраняем локально…');
    const timer = window.setTimeout(() => {
      const savedAt = writeTestEditorDraft(window.localStorage, editorIdRef.current, course);
      setDraftMessage(
        savedAt ? `Автосохранено · ${formatDraftTime(savedAt)}` : 'Автосохранение недоступно',
      );
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [course, dirty, draftReady]);

  const updateQuestion = (update: Partial<AdminTestQuestion>) => {
    setCourse((current) => ({
      ...current,
      questionVariants: current.questionVariants.map((variant, variantIndex) =>
        variantIndex === activeVariant
          ? {
              ...variant,
              questions: variant.questions.map((question, questionIndex) =>
                questionIndex === activeQuestion ? { ...question, ...update } : question,
              ),
            }
          : variant,
      ) as [AdminTestVariant, AdminTestVariant, AdminTestVariant],
    }));
  };

  const updateOption = (optionIndex: number, text: string) => {
    if (!currentQuestion) return;
    updateQuestion({
      options: currentQuestion.options.map((option, index) =>
        index === optionIndex ? { ...option, text } : option,
      ),
    });
  };

  const moveQuestion = (direction: -1 | 1) => {
    const target = activeQuestion + direction;
    if (!currentVariant || target < 0 || target >= currentVariant.questions.length) return;
    setCourse((current) => {
      const variants = current.questionVariants.map((variant, index) => {
        if (index !== activeVariant) return variant;
        const questions = [...variant.questions];
        [questions[activeQuestion], questions[target]] = [
          questions[target]!,
          questions[activeQuestion]!,
        ];
        return { ...variant, questions };
      }) as [AdminTestVariant, AdminTestVariant, AdminTestVariant];
      return { ...current, questionVariants: variants };
    });
    setActiveQuestion(target);
  };

  const save = async (publish: boolean) => {
    setValidationAttempted(true);
    const effectiveValidation = publish ? validation : draftValidation;
    if (!effectiveValidation.valid) {
      setError(
        'Исправьте отмеченные поля. Для публикации нужны готовая PDF-презентация и 30 заполненных вопросов.',
      );
      if (effectiveValidation.firstInvalidVariantIndex !== null)
        setActiveVariant(effectiveValidation.firstInvalidVariantIndex);
      if (effectiveValidation.firstInvalidQuestionIndex !== null)
        setActiveQuestion(effectiveValidation.firstInvalidQuestionIndex);
      window.setTimeout(
        () =>
          document
            .getElementById(effectiveValidation.firstInvalidFieldId ?? '')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        0,
      );
      return;
    }
    if (publish && !window.confirm('Опубликовать новую неизменяемую редакцию курса?')) return;
    setBusy(true);
    setError('');
    try {
      const {
        presentation: _presentation,
        publicationState: _publicationState,
        contentHash: _contentHash,
        status: _status,
        revisionHistory: _revisionHistory,
        ...editableCourse
      } = course;
      const result = await clientRequest('/api/admin/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editableCourse, id: course.id ?? null, publish }),
      });
      const payload = await readClientResponseJson<{
        id?: string;
        draftVersion?: number;
        contentHash?: string;
        publicationState?: PublicationState;
        error?: string;
      }>(result.response);
      if (!result.ok || !payload?.id) throw new Error(payload?.error ?? 'COURSE_SAVE_FAILED');
      const next = {
        ...course,
        id: payload.id,
        draftVersion: payload.draftVersion ?? course.draftVersion,
        contentHash: payload.contentHash ?? course.contentHash,
        publicationState: payload.publicationState ?? (publish ? 'published' : 'draft'),
      } satisfies TestEditorPayload;
      setCourse(next);
      setSavedSnapshot(serializeTestEditorPayload(next));
      clearTestEditorDraft(window.localStorage, editorIdRef.current);
      if (!course.id) {
        editorIdRef.current = payload.id;
        approveNavigation();
        router.replace(`/admin/courses/${payload.id}`);
      } else router.refresh();
    } catch (saveError) {
      setError(
        saveError instanceof Error && saveError.message === 'COURSE_CATALOG_MAINTENANCE'
          ? 'Каталог находится в режиме обслуживания. Завершите переключение или отключите режим перед редактированием.'
          : clientRequestMessage(saveError, 'Не удалось сохранить курс. Повторите попытку.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const publicationState =
    dirty && course.publicationState === 'published'
      ? 'published_with_draft_changes'
      : (course.publicationState ?? 'never_published');

  return (
    <EditorShell>
      <EditorActionBar
        busy={busy}
        preview={preview}
        statusLabel={PUBLICATION_LABEL[publicationState]}
        published={
          publicationState === 'published' || publicationState === 'published_with_draft_changes'
        }
        hasDraftChanges={publicationState === 'published_with_draft_changes'}
        progress={`${validation.completedCount}/30`}
        liveMessage={`${dirty ? 'Есть изменения. ' : ''}${draftMessage}`}
        onTogglePreview={() => setPreview((value) => !value)}
        onSave={() => void save(false)}
        onPublish={() => void save(true)}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]"
        >
          {error}
        </p>
      ) : null}

      {preview ? (
        <Card>
          <CardHeader>
            <Badge variant="sapphire" className="w-fit">
              Предпросмотр
            </Badge>
            <CardTitle>{course.title || 'Название курса'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>{course.description || 'Описание курса'}</p>
            <p className="text-sm font-bold">
              {course.durationMinutes} мин · проходной балл {course.passScore}/10 ·{' '}
              {course.attemptsPerCalendarDay} попыток в день
            </p>
            {course.presentation ? (
              <p className="text-sm">
                PDF: {course.presentation.pageCount} страниц ·{' '}
                {(course.presentation.byteSize / 1024 / 1024).toFixed(1)} МБ
              </p>
            ) : (
              <p className="text-sm text-[var(--color-danger)]">PDF не загружен</p>
            )}
            {currentQuestion ? (
              <div className="rounded-xl border p-4">
                <h2 className="font-bold">
                  Вариант {activeVariant + 1}, вопрос {activeQuestion + 1}
                </h2>
                <p className="mt-2">{currentQuestion.text || 'Текст вопроса'}</p>
                {currentQuestion.options.map((option, index) => (
                  <p key={option.id} className="mt-1 text-sm">
                    {index + 1}. {option.text || 'Вариант ответа'}
                  </p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>1. Основные сведения</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="test-title">Название</Label>
                <Input
                  id="test-title"
                  value={course.title}
                  invalid={validationAttempted && Boolean(validation.fieldErrors['test-title'])}
                  onChange={(event) =>
                    setCourse((current) => ({ ...current, title: event.target.value }))
                  }
                />
                <FieldError
                  id="test-title"
                  message={validationAttempted ? validation.fieldErrors['test-title'] : undefined}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-slug">Slug</Label>
                <Input
                  id="test-slug"
                  value={course.slug}
                  invalid={validationAttempted && Boolean(validation.fieldErrors['test-slug'])}
                  onChange={(event) =>
                    setCourse((current) => ({ ...current, slug: event.target.value.toLowerCase() }))
                  }
                />
                <FieldError
                  id="test-slug"
                  message={validationAttempted ? validation.fieldErrors['test-slug'] : undefined}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-display-order">Порядок в каталоге</Label>
                <Input
                  id="test-display-order"
                  type="number"
                  min={1}
                  value={course.displayOrder}
                  onChange={(event) =>
                    setCourse((current) => ({
                      ...current,
                      displayOrder: Number(event.target.value),
                    }))
                  }
                />
                <FieldError
                  id="test-display-order"
                  message={
                    validationAttempted ? validation.fieldErrors['test-display-order'] : undefined
                  }
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="test-description">Описание</Label>
                <Textarea
                  id="test-description"
                  value={course.description}
                  onChange={(event) =>
                    setCourse((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </div>
              <div className="md:col-span-2">
                <IconPicker
                  value={course.icon}
                  onChange={(icon) => setCourse((current) => ({ ...current, icon }))}
                />
              </div>
            </CardContent>
          </Card>

          <Card id="test-presentation">
            <CardHeader>
              <CardTitle>2. Презентация</CardTitle>
            </CardHeader>
            <CardContent>
              <CoursePresentationInput
                courseId={course.id ?? null}
                value={course.presentation}
                onChange={(presentation) =>
                  setCourse((current) => ({
                    ...current,
                    presentation,
                    presentationId: presentation?.id ?? null,
                  }))
                }
              />
              <FieldError
                id="test-presentation"
                message={
                  validationAttempted ? validation.fieldErrors['test-presentation'] : undefined
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>3. Правила прохождения</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="test-duration">Минуты</Label>
                <Input
                  id="test-duration"
                  type="number"
                  min={1}
                  max={120}
                  value={course.durationMinutes}
                  onChange={(event) =>
                    setCourse((current) => ({
                      ...current,
                      durationMinutes: Number(event.target.value),
                    }))
                  }
                />
                <FieldError
                  id="test-duration"
                  message={
                    validationAttempted ? validation.fieldErrors['test-duration'] : undefined
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-pass-score">Проходной балл</Label>
                <Input
                  id="test-pass-score"
                  type="number"
                  min={1}
                  max={10}
                  value={course.passScore}
                  onChange={(event) =>
                    setCourse((current) => ({ ...current, passScore: Number(event.target.value) }))
                  }
                />
                <FieldError
                  id="test-pass-score"
                  message={
                    validationAttempted ? validation.fieldErrors['test-pass-score'] : undefined
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-attempt-limit">Попыток в день</Label>
                <Input
                  id="test-attempt-limit"
                  type="number"
                  min={1}
                  max={50}
                  value={course.attemptsPerCalendarDay}
                  onChange={(event) =>
                    setCourse((current) => ({
                      ...current,
                      attemptsPerCalendarDay: Number(event.target.value),
                    }))
                  }
                />
                <FieldError
                  id="test-attempt-limit"
                  message={
                    validationAttempted ? validation.fieldErrors['test-attempt-limit'] : undefined
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-timezone">Часовой пояс</Label>
                <Input id="test-timezone" value={course.attemptResetTimezone} readOnly />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>4–6. Варианты теста</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Варианты теста">
                {course.questionVariants.map((variant, index) => (
                  <Button
                    key={variant.variantNumber}
                    id={`variant-tab-${index}`}
                    type="button"
                    role="tab"
                    aria-selected={activeVariant === index}
                    variant={activeVariant === index ? 'primary' : 'outline'}
                    onClick={() => {
                      setActiveVariant(index);
                      setActiveQuestion(0);
                    }}
                  >
                    Вариант {variant.variantNumber}
                    <span className="hidden sm:inline">
                      {' '}
                      · {validation.questionComplete[index]?.filter(Boolean).length ?? 0}/10
                    </span>
                  </Button>
                ))}
              </div>
              <nav aria-label="Вопросы теста" className="grid grid-cols-5 gap-2 sm:grid-cols-10">
                {currentVariant?.questions.map((question, index) => (
                  <Button
                    key={question.id}
                    id={`question-step-${index}`}
                    type="button"
                    size="icon"
                    variant={activeQuestion === index ? 'primary' : 'outline'}
                    aria-controls={`question-panel-${index}`}
                    aria-expanded={activeQuestion === index}
                    aria-label={`Вопрос ${index + 1}`}
                    className={cn(
                      'w-full',
                      validation.questionComplete[activeVariant]?.[index] &&
                        activeQuestion !== index &&
                        'border-[var(--color-success)]',
                    )}
                    onClick={() => setActiveQuestion(index)}
                  >
                    {index + 1}
                  </Button>
                ))}
              </nav>
              {currentQuestion ? (
                <div
                  id={`question-panel-${activeQuestion}`}
                  role="region"
                  aria-labelledby={`question-step-${activeQuestion}`}
                  className="space-y-5 rounded-xl border border-[var(--color-border)] p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold">
                      Вариант {activeVariant + 1} · вопрос {activeQuestion + 1}
                    </h3>
                    <div className="flex">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Переместить вопрос вверх"
                        disabled={activeQuestion === 0}
                        onClick={() => moveQuestion(-1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Переместить вопрос вниз"
                        disabled={activeQuestion === 9}
                        onClick={() => moveQuestion(1)}
                      >
                        <ArrowDown />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`variant-${activeVariant}-question-${activeQuestion}`}>
                      Текст вопроса
                    </Label>
                    <Textarea
                      id={`variant-${activeVariant}-question-${activeQuestion}`}
                      value={currentQuestion.text}
                      onChange={(event) => updateQuestion({ text: event.target.value })}
                    />
                    <FieldError
                      id={`variant-${activeVariant}-question-${activeQuestion}`}
                      message={
                        validationAttempted
                          ? validation.fieldErrors[
                              `variant-${activeVariant}-question-${activeQuestion}`
                            ]
                          : undefined
                      }
                    />
                    <FieldWarning
                      id={`variant-${activeVariant}-question-${activeQuestion}`}
                      message={
                        validation.fieldWarnings[
                          `variant-${activeVariant}-question-${activeQuestion}`
                        ]
                      }
                    />
                  </div>
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-bold">Ровно четыре ответа</legend>
                    {currentQuestion.options.map((option, index) => {
                      const fieldId = `variant-${activeVariant}-question-${activeQuestion}-option-${index}`;
                      return (
                        <div key={option.id} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`correct-${currentQuestion.id}`}
                              className="size-5 accent-[var(--color-primary)]"
                              checked={currentQuestion.correctOptionId === option.id}
                              onChange={() => updateQuestion({ correctOptionId: option.id })}
                              aria-label={`Ответ ${index + 1} правильный`}
                            />
                            <Input
                              id={fieldId}
                              value={option.text}
                              placeholder={`Ответ ${index + 1}`}
                              onChange={(event) => updateOption(index, event.target.value)}
                            />
                          </div>
                          <FieldError
                            id={fieldId}
                            message={
                              validationAttempted ? validation.fieldErrors[fieldId] : undefined
                            }
                          />
                          <FieldWarning id={fieldId} message={validation.fieldWarnings[fieldId]} />
                        </div>
                      );
                    })}
                  </fieldset>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor={`variant-${activeVariant}-question-${activeQuestion}-explanation`}
                    >
                      Пояснение (необязательно)
                    </Label>
                    <Textarea
                      id={`variant-${activeVariant}-question-${activeQuestion}-explanation`}
                      value={currentQuestion.explanation}
                      onChange={(event) => updateQuestion({ explanation: event.target.value })}
                    />
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>7. Проверка перед публикацией</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-[var(--color-surface-muted)] p-3">
                  <p className="text-xs text-[var(--color-text-subtle)]">Презентация</p>
                  <p className="mt-1 font-bold">
                    {course.presentation?.status === 'ready' ? 'PDF готов' : 'PDF не готов'}
                  </p>
                </div>
                <div className="rounded-xl bg-[var(--color-surface-muted)] p-3">
                  <p className="text-xs text-[var(--color-text-subtle)]">Вопросы</p>
                  <p className="mt-1 font-bold">{validation.completedCount}/30 заполнено</p>
                </div>
                <div className="rounded-xl bg-[var(--color-surface-muted)] p-3">
                  <p className="text-xs text-[var(--color-text-subtle)]">Политика</p>
                  <p className="mt-1 font-bold">
                    {course.durationMinutes} мин · {course.passScore}/10 ·{' '}
                    {course.attemptsPerCalendarDay}/день
                  </p>
                </div>
              </div>
              <div
                role="status"
                className={cn(
                  'rounded-xl p-3 text-sm font-semibold',
                  validation.valid
                    ? 'bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]'
                    : 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
                )}
              >
                {validation.valid
                  ? 'Курс готов к публикации новой неизменяемой редакции.'
                  : `Публикация заблокирована: исправьте ${validationMessages.length} ${validationMessages.length === 1 ? 'ошибку' : 'ошибок'}.`}
              </div>
              {!validation.valid && validationAttempted ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-danger)]">
                  {validationMessages.slice(0, 8).map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              ) : null}
              {validationWarnings.length > 0 ? (
                <div className="rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm text-[var(--color-warning)]">
                  <p className="font-bold">Проверьте повторяющиеся формулировки:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {validationWarnings.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                  <p className="mt-2">Это предупреждение не блокирует публикацию.</p>
                </div>
              ) : null}
              <div className="border-t border-[var(--color-border)] pt-5">
                <h3 className="mb-3 font-bold">SEO публикации</h3>
                <ContentSeoEditor
                  idPrefix="course"
                  value={course.seo}
                  onChange={(seo) => setCourse((current) => ({ ...current, seo }))}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>8. История редакций</CardTitle>
            </CardHeader>
            <CardContent>
              {course.revisionHistory.length > 0 ? (
                <ol className="space-y-3">
                  {course.revisionHistory.map((revision) => (
                    <li
                      key={revision.id}
                      className="rounded-xl border border-[var(--color-border)] p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-bold">Редакция {revision.version}</p>
                        {revision.current ? <Badge variant="sapphire">Текущая</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                        Опубликована {formatDateTime(revision.publishedAt, 'ru-RU')}
                      </p>
                      <p
                        className="mt-1 truncate font-mono text-xs text-[var(--color-text-subtle)]"
                        title={revision.contentHash}
                      >
                        SHA-256 контента: {revision.contentHash}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-[var(--color-text-muted)]">
                  Опубликованных редакций пока нет. Первая запись появится после публикации.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </EditorShell>
  );
}
