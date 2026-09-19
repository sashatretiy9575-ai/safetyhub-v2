'use client';

import { ArrowDown, ArrowUp } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { APP_LOCALES, type AppLocale } from '@/i18n/config';
import type {
  AdminTestQuestion,
  AdminTestVariant,
  TestEditorSeed,
  TestEditorPayload,
} from '@/lib/admin/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  serializeTestEditorPayload,
  TEST_EDITOR_LIMITS,
  TEST_EDITOR_TOTAL_QUESTIONS,
  validateTestEditor,
} from '@/lib/admin/course-test-editor';
import {
  COURSE_UNSAVED_LOCALES_EVENT,
  courseLocaleBlockers,
  courseLocaleGaps,
  courseLocaleUnsavedNotice,
  type CourseLocaleBlockers,
} from '@/lib/admin/course-readiness';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { defaultContentSeo } from '@/lib/validation/content-seo';
import { withCourseSeoDefaults } from '@/lib/validation/course-seo-defaults';
import { resolveCourseIcon } from '@/lib/content/course-icons';
import { IconPicker } from '@/components/admin/icon-picker';
import { ContentSeoEditor } from '@/components/admin/content-seo-editor';
import { CoursePresentationInput } from '@/components/admin/course-presentation-input';
import { EditorActionBar } from '@/components/admin/editor-action-bar';
import { EditorShell } from '@/components/admin/editor-shell';
import { useUnsavedChangesGuard } from '@/components/admin/use-unsaved-changes-guard';
import { useAdminListHref } from '@/components/admin/use-admin-list-href';
import { cn, formatDateTime } from '@/lib/utils';
import { confirmDialog } from '@/components/admin/confirm-dialog';

type PublicationState = NonNullable<TestEditorPayload['publicationState']>;
// «Опубликован» used to stand for a live course with and without a newer draft
// alike. A live course names its revision instead; see `statusLabel` below.
const PUBLICATION_LABEL: Record<PublicationState, string> = {
  never_published: 'Не опубликован',
  draft: 'Снят с публикации',
  published: 'Опубликован',
  published_with_draft_changes: 'Опубликован · есть черновик',
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

function freshTestFromSeed(seed?: TestEditorSeed): TestEditorPayload {
  const empty = emptyTest();
  if (!seed) return empty;

  // Still an explicit allowlist rather than a spread, so a future server field
  // cannot leak into the editor by accident. The saved question bank is now
  // deliberately part of it: an administrator has to see what they are editing,
  // and the blank set used to overwrite the stored one on the first save.
  return {
    ...(seed.id ? { id: seed.id } : {}),
    slug: seed.slug,
    title: seed.title,
    description: seed.description,
    icon: resolveCourseIcon(seed.icon).id,
    displayOrder: seed.displayOrder,
    durationMinutes: seed.durationMinutes,
    passScore: seed.passScore,
    attemptsPerCalendarDay: seed.attemptsPerCalendarDay,
    attemptResetTimezone: seed.attemptResetTimezone,
    presentationId: seed.presentationId,
    presentation: seed.presentation ? { ...seed.presentation } : null,
    jurisdiction: seed.jurisdiction,
    effectiveDate: seed.effectiveDate,
    sources: seed.sources.map((source) => ({ ...source })),
    ...(seed.status ? { status: seed.status } : {}),
    ...(seed.publicationState ? { publicationState: seed.publicationState } : {}),
    ...(seed.draftVersion !== undefined ? { draftVersion: seed.draftVersion } : {}),
    // Courses created before SEO was collected carry `{}`. Spreading that left
    // every SEO field blank in the editor and blocked publication with nothing
    // to look at, so any missing field is filled from the course's own title and
    // description. Whatever the course actually stores always wins.
    seo: withCourseSeoDefaults('ru', seed.title, seed.description, seed.seo),
    revisionHistory: seed.revisionHistory.map((revision) => ({ ...revision })),
    questionVariants: seed.questionVariants
      ? (seed.questionVariants.map((variant) => ({
          ...variant,
          questions: variant.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option })),
          })),
        })) as TestEditorPayload['questionVariants'])
      : empty.questionVariants,
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

// Russian has three plural forms; the previous condition had two, so anything
// but a single error read "исправьте 2 ошибок".
const RU_PLURAL_RULES = new Intl.PluralRules('ru-RU');
const ERROR_NOUNS: Record<Intl.LDMLPluralRule, string> = {
  zero: 'ошибок',
  one: 'ошибку',
  two: 'ошибки',
  few: 'ошибки',
  many: 'ошибок',
  other: 'ошибки',
};

function errorNoun(count: number) {
  return ERROR_NOUNS[RU_PLURAL_RULES.select(count)];
}

const REASON_NOUNS: Record<Intl.LDMLPluralRule, string> = {
  zero: 'причин',
  one: 'причина',
  two: 'причины',
  few: 'причины',
  many: 'причин',
  other: 'причины',
};

/**
 * The message area names the first thing to fix and counts the rest; the whole
 * list is in step 7. The sentences this replaced told the administrator to
 * prepare all four languages and never said which part of which one was missing.
 */
function firstAndMore(messages: readonly string[]) {
  const [first, ...rest] = messages;
  if (!first) return '';
  const lead = first.replace(/\.$/u, '');
  return rest.length > 0 ? `${lead} и ещё ${rest.length}` : lead;
}

function blockedMessage(blockers: readonly string[]) {
  return `Черновик сохранён. ${firstAndMore(blockers) || 'Публикация заблокирована'}.`;
}

export function TestEditor({
  initial,
  initialPublicationNotice = null,
  localeBlockers,
  heading,
}: {
  initial?: TestEditorSeed;
  initialPublicationNotice?: 'incomplete' | 'failed' | null;
  /** What stops publication in each language, from the saved rows. Absent for a course not saved yet. */
  localeBlockers?: CourseLocaleBlockers;
  /** The page's heading, shown beside «Назад». */
  heading?: ReactNode;
}) {
  const router = useRouter();
  const listHref = useAdminListHref('/admin/courses');
  const normalizedInitial = useMemo(() => freshTestFromSeed(initial), [initial]);
  const bankLoaded = Boolean(initial?.questionVariants);
  // The bank could not be read at all (the read path is missing in this
  // environment). Its real contents are unknown, so saving would ship the blank
  // placeholder over a full bank — exactly the silent data loss this editor used
  // to cause. Open read-only instead.
  const bankUnreadable = Boolean(initial) && initial?.questionBankReadable === false;
  const [course, setCourse] = useState<TestEditorPayload>(normalizedInitial);
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    serializeTestEditorPayload(normalizedInitial),
  );
  const [activeVariant, setActiveVariant] = useState(0);
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  // A course that was never saved has no translations yet, and says so.
  const savedBlockers = useMemo(() => localeBlockers ?? courseLocaleBlockers([]), [localeBlockers]);
  const [error, setError] = useState(() =>
    initialPublicationNotice === 'incomplete'
      ? blockedMessage(APP_LOCALES.flatMap((locale) => savedBlockers[locale]))
      : initialPublicationNotice === 'failed'
        ? 'Черновик сохранён. Опубликовать не удалось.'
        : '',
  );
  const [validationAttempted, setValidationAttempted] = useState(false);
  // What the publish route refused with, until the refreshed page replaces it.
  const [refusedBlockers, setRefusedBlockers] = useState<string[] | null>(null);
  // Locale tabs below that hold unsaved work. They are a sibling component under
  // a server page, so they announce themselves on `window`.
  const [unsavedLocales, setUnsavedLocales] = useState<readonly AppLocale[]>([]);

  const snapshot = useMemo(() => serializeTestEditorPayload(course), [course]);
  const dirty = snapshot !== savedSnapshot;
  const approveNavigation = useUnsavedChangesGuard(dirty);
  const validation = useMemo(() => validateTestEditor(course), [course]);
  // The draft-mode validation is only consulted when saving, so it is run
  // there rather than on every keystroke: it walks 3 variants x 10 questions
  // x 4 options and parses two Zod schemas.
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

  // Russian is judged by the open form — it is saved before every publication
  // attempt — and only once the form validates: until then the count below
  // already speaks for it. The translations are judged by their saved rows, and
  // a tab with unsaved work is named instead of rows that are about to change.
  const blockers = useMemo(() => {
    if (refusedBlockers) return refusedBlockers;
    return APP_LOCALES.flatMap((locale) => {
      if (locale !== 'ru') {
        return unsavedLocales.includes(locale)
          ? [courseLocaleUnsavedNotice(locale)]
          : savedBlockers[locale];
      }
      if (!validation.valid) return [];
      return courseLocaleGaps(
        {
          locale,
          status: 'complete',
          title: course.title,
          description: course.description,
          seoStored: { title: course.seo.title, description: course.seo.description },
          presentation: course.presentation ? { status: course.presentation.status } : null,
          assessmentImported: true,
          assessmentGaps: {
            total: validation.completedCount,
            emptyTexts: 0,
            missingExplanations: 0,
            russianTexts: 0,
          },
        },
        null,
      );
    });
  }, [
    course.description,
    course.presentation,
    course.seo.description,
    course.seo.title,
    course.title,
    refusedBlockers,
    savedBlockers,
    unsavedLocales,
    validation.completedCount,
    validation.valid,
  ]);

  useEffect(() => {
    const onUnsavedLocales = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      setUnsavedLocales(
        Array.isArray(detail)
          ? APP_LOCALES.filter((locale) => locale !== 'ru' && detail.includes(locale))
          : [],
      );
    };
    window.addEventListener(COURSE_UNSAVED_LOCALES_EVENT, onUnsavedLocales);
    return () => window.removeEventListener(COURSE_UNSAVED_LOCALES_EVENT, onUnsavedLocales);
  }, []);

  // `router.refresh()` after a save, a publication or a withdrawal brings a new
  // seed. The form keeps what is being typed; the revision history is the
  // server's alone — it is not even part of the unsaved-changes comparison — and
  // the refusal the refreshed list of blockers now covers is dropped.
  const seededRef = useRef(normalizedInitial);
  useEffect(() => {
    if (seededRef.current === normalizedInitial) return;
    seededRef.current = normalizedInitial;
    setCourse((current) => ({ ...current, revisionHistory: normalizedInitial.revisionHistory }));
    setRefusedBlockers(null);
  }, [normalizedInitial]);

  useEffect(() => {
    // Previous releases stored full question sets (including answer keys) in
    // browser storage. Remove those keys by name without reading their values.
    try {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (
          key?.startsWith('safetyhub:course-editor-draft:v2:') ||
          key?.startsWith('safetyhub:editor-draft:v1:course:')
        ) {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      // Storage may be unavailable in a hardened browser. The editor never
      // writes a local copy, so absence of cleanup does not create a new leak.
    }
  }, []);

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

  const copyVariantFrom = (sourceIndex: number, targetIndex: number) => {
    setCourse((current) => {
      const sourceVariant = current.questionVariants[sourceIndex];
      if (!sourceVariant) return current;
      const clonedQuestions: AdminTestQuestion[] = sourceVariant.questions.map((q) => {
        const clonedOptions = q.options.map((opt) => ({
          id: crypto.randomUUID(),
          text: opt.text,
        }));
        const origCorrectIdx = q.options.findIndex((opt) => opt.id === q.correctOptionId);
        const newCorrectId =
          clonedOptions[origCorrectIdx !== -1 ? origCorrectIdx : 0]?.id ?? clonedOptions[0]!.id;
        return {
          id: crypto.randomUUID(),
          text: q.text,
          options: clonedOptions,
          correctOptionId: newCorrectId,
          explanation: q.explanation,
        };
      });

      const nextVariants = [...current.questionVariants] as [
        AdminTestVariant,
        AdminTestVariant,
        AdminTestVariant,
      ];
      nextVariants[targetIndex] = {
        ...nextVariants[targetIndex]!,
        questions: clonedQuestions,
      };

      return {
        ...current,
        questionVariants: nextVariants,
      };
    });
  };

  const persistDraftOrPublish = async (publish: boolean) => {
    if (bankUnreadable) {
      setError(
        'Банк вопросов сейчас недоступен для чтения, поэтому сохранение выключено — иначе сохранённые вопросы были бы стёрты. Обновите базу данных и откройте курс заново.',
      );
      return;
    }
    setValidationAttempted(true);
    const effectiveValidation = publish
      ? validation
      : validateTestEditor(course, { publish: false });
    if (!effectiveValidation.valid) {
      setError(`${firstAndMore([...new Set(Object.values(effectiveValidation.fieldErrors))])}.`);
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
    // The publish route judges saved rows and cannot see a locale tab that was
    // edited and not saved: the revision would go live without that work.
    if (publish && unsavedLocales.length > 0) {
      setError(`${firstAndMore(unsavedLocales.map(courseLocaleUnsavedNotice))}.`);
      return;
    }
    if (
      publish &&
      !(await confirmDialog({
        title: 'Опубликовать новую редакцию курса?',
        description:
          'Опубликованная редакция неизменяема: учащиеся сразу увидят её, а дальнейшие правки создадут следующую редакцию.',
        tone: 'primary',
        confirmLabel: 'Опубликовать',
        busyLabel: 'Публикуем…',
      }))
    ) {
      return;
    }
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
        // Canonical RU authoring is saved first. The four-locale publisher is
        // a separate atomic RPC and refuses any incomplete locale matrix.
        body: JSON.stringify({ ...editableCourse, id: course.id ?? null, publish: false }),
      });
      const payload = await readClientResponseJson<{
        id?: string;
        draftVersion?: number;
        contentHash?: string;
        publicationState?: PublicationState;
        error?: string;
      }>(result.response);
      if (!result.ok || !payload?.id || !payload.contentHash || !payload.draftVersion) {
        throw new Error(payload?.error ?? 'COURSE_SAVE_FAILED');
      }
      // Only the fields the server owns are merged back, on top of whatever the
      // form holds now. Replacing the whole object with the snapshot taken when
      // the request started silently discarded every edit made while it ran.
      const live =
        course.publicationState === 'published' ||
        course.publicationState === 'published_with_draft_changes';
      const savedFields = {
        id: payload.id,
        draftVersion: payload.draftVersion ?? course.draftVersion,
        contentHash: payload.contentHash ?? course.contentHash,
        // Saving a draft does not withdraw a published course. The state is
        // whether the published revision still matches what was just saved: a
        // live course with a newer draft used to come back as `draft`, which the
        // badge reads as «Снят с публикации».
        publicationState: live
          ? course.revisionHistory?.find((revision) => revision.current)?.contentHash ===
            payload.contentHash
            ? ('published' as const)
            : ('published_with_draft_changes' as const)
          : (course.publicationState ?? ('never_published' as const)),
      };
      setCourse((current) => ({ ...current, ...savedFields }));
      setSavedSnapshot(
        serializeTestEditorPayload({ ...course, ...savedFields } as TestEditorPayload),
      );
      let next: TestEditorPayload = { ...course, ...savedFields };
      let publishedRevision: TestEditorPayload['revisionHistory'][number] | null = null;
      if (publish) {
        const publication = await clientRequest(
          `/api/admin/courses/${encodeURIComponent(payload.id)}/localizations/publish`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedContentHash: payload.contentHash }),
          },
        );
        const publicationPayload = await readClientResponseJson<{
          error?: string;
          blockers?: string[];
          revisionId?: string;
          version?: number | null;
        }>(publication.response);
        if (!publication.ok) {
          const incomplete = publicationPayload?.error === 'COURSE_LOCALIZATIONS_INCOMPLETE';
          if (incomplete) {
            // The route names what is missing in the saved rows; step 7 lists it.
            const refused = (publicationPayload?.blockers ?? []).filter(
              (line) => typeof line === 'string',
            );
            setRefusedBlockers(refused);
            setError(blockedMessage(refused));
          } else {
            setError(
              clientRequestMessage(
                publication.error,
                'Черновик сохранён. Опубликовать не удалось.',
              ),
            );
          }
          if (!course.id) {
            approveNavigation();
            router.replace(
              `/admin/courses/${payload.id}?publication=${incomplete ? 'incomplete' : 'failed'}`,
            );
          } else router.refresh();
          return;
        }
        next = { ...next, publicationState: 'published' };
        // The badge names the live revision. The refreshed page brings the real
        // history a moment later; until then the number just published is shown
        // rather than the previous one.
        if (publicationPayload?.revisionId && publicationPayload.version) {
          publishedRevision = {
            id: publicationPayload.revisionId,
            version: publicationPayload.version,
            publishedAt: new Date().toISOString(),
            contentHash: payload.contentHash,
            presentationId: course.presentationId,
            current: true,
          };
        }
      }
      const revision = publishedRevision;
      const publishedFields = { publicationState: next.publicationState };
      setCourse((current) => ({
        ...current,
        ...publishedFields,
        ...(revision
          ? {
              revisionHistory: [
                revision,
                ...current.revisionHistory.map((entry) => ({ ...entry, current: false })),
              ],
            }
          : {}),
      }));
      setSavedSnapshot(serializeTestEditorPayload(next));
      if (!course.id) {
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

  // Named entry points: `save(true)` and `save(false)` at the call site said
  // nothing about which of the two things they did.
  const saveDraft = () => persistDraftOrPublish(false);
  const publishRevision = () => persistDraftOrPublish(true);

  // The list row used to be the only place a course could be withdrawn from.
  const unpublish = async () => {
    const courseId = course.id;
    if (!courseId) return;
    if (
      !(await confirmDialog({
        title: 'Снять курс с публикации?',
        description:
          'Курс перейдёт в статус черновика и временно перестанет быть доступен учащимся на портале. Опубликовать его снова можно из редактора.',
        confirmLabel: 'Снять с публикации',
        busyLabel: 'Снимаем…',
        tone: 'danger',
      }))
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest(
        `/api/admin/courses/${encodeURIComponent(courseId)}/status`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'draft' }),
        },
      );
      if (!result.ok) {
        setError(clientRequestMessage(result.error, 'Не удалось снять курс с публикации.'));
        return;
      }
      const withdrawn = { publicationState: 'draft' } satisfies Partial<TestEditorPayload>;
      setCourse((current) => ({ ...current, ...withdrawn }));
      // The state is part of the unsaved-changes comparison. Only that field is
      // moved in the saved side, so edits made before the withdrawal stay unsaved.
      setSavedSnapshot((saved) => JSON.stringify({ ...JSON.parse(saved), ...withdrawn }));
      router.refresh();
    } catch (statusError) {
      setError(clientRequestMessage(statusError, 'Не удалось снять курс с публикации.'));
    } finally {
      setBusy(false);
    }
  };

  const publicationState =
    dirty && course.publicationState === 'published'
      ? 'published_with_draft_changes'
      : (course.publicationState ?? 'never_published');
  const liveRevision = course.revisionHistory.find((revision) => revision.current)?.version;
  // By precedence: unsaved edits, the live revision, a live course with a newer
  // draft, a withdrawn course, a course that was never published.
  const statusLabel = dirty
    ? 'Не сохранено'
    : publicationState === 'published' && liveRevision
      ? `Опубликована редакция ${liveRevision}`
      : PUBLICATION_LABEL[publicationState];

  return (
    <EditorShell>
      <div className="flex min-w-0 items-center gap-2">
        {/* The same way back the article editor has, to the list as it was
            left. It is a link, so the unsaved-changes guard asks first. */}
        <Button asChild variant="ghost" className="min-h-11 shrink-0">
          <Link href={listHref}>Назад</Link>
        </Button>
        {heading ? <div className="min-w-0">{heading}</div> : null}
      </div>

      <EditorActionBar
        busy={busy || bankUnreadable}
        preview={preview}
        statusLabel={statusLabel}
        statusTone={dirty ? 'warning' : undefined}
        published={
          publicationState === 'published' || publicationState === 'published_with_draft_changes'
        }
        progress={`${validation.completedCount}/${TEST_EDITOR_TOTAL_QUESTIONS}`}
        liveMessage={
          bankUnreadable
            ? 'Только просмотр: банк вопросов недоступен, сохранение выключено.'
            : dirty
              ? 'Есть несохранённые изменения.'
              : bankLoaded
                ? 'Изменений нет.'
                : 'Черновик хранится только в памяти до отправки.'
        }
        onTogglePreview={() => setPreview((value) => !value)}
        onSave={() => void saveDraft()}
        onPublish={() => void publishRevision()}
        onUnpublish={course.id ? () => void unpublish() : undefined}
      />

      {/* Only states that change what the administrator can do are worth a line
          here. A bank that loaded normally is the expected case and says so by
          simply showing the questions. */}
      {course.id && (bankUnreadable || !bankLoaded) ? (
        <p
          data-course-editor-key-boundary
          className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-surface-muted)] p-4 text-sm leading-6"
        >
          {bankUnreadable
            ? 'Банк вопросов сейчас прочитать нельзя, поэтому сохранение и публикация выключены: иначе сохранённые вопросы были бы стёрты. Остальные поля курса показаны только для просмотра. Обновите базу данных и откройте курс заново.'
            : `Сохранённого банка вопросов нет или он неполный — заполните ${TEST_EDITOR_TOTAL_QUESTIONS} вопросов заново. Текущая опубликованная редакция работает, пока вы не опубликуете новую.`}
        </p>
      ) : null}

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
            <CardTitle as="h2">{course.title || 'Название курса'}</CardTitle>
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
                <h3 className="font-bold">
                  Вариант {activeVariant + 1}, вопрос {activeQuestion + 1}
                </h3>
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
        // Disabled while a save is running. The action bar used to grey out only
        // its own buttons, so the form stayed editable and anything typed during
        // the request was overwritten when the response came back.
        <fieldset disabled={busy} className="contents">
          <Card>
            <CardHeader>
              <CardTitle as="h2">1. Основные сведения</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label className="sr-only" htmlFor="test-title">Название</Label>
                <Input
          placeholder="Название"
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
                <Label className="sr-only" htmlFor="test-slug">Slug</Label>
                <Input
          placeholder="Slug"
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
                <Label className="sr-only" htmlFor="test-display-order">Порядок в каталоге</Label>
                <Input
          placeholder="Порядок в каталоге"
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
                <Label className="sr-only" htmlFor="test-description">Описание</Label>
                <Textarea
          placeholder="Описание"
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
              <CardTitle as="h2">2. Презентация</CardTitle>
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
              <CardTitle as="h2">3. Правила прохождения</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label className="sr-only" htmlFor="test-duration">Минуты</Label>
                <Input
          placeholder="Минуты"
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
                <Label className="sr-only" htmlFor="test-pass-score">Проходной балл</Label>
                <Input
          placeholder="Проходной балл"
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
                <Label className="sr-only" htmlFor="test-attempt-limit">Попыток в день</Label>
                <Input
          placeholder="Попыток в день"
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
                <Label className="sr-only" htmlFor="test-timezone">Часовой пояс</Label>
                <Input
          placeholder="Часовой пояс" id="test-timezone" value={course.attemptResetTimezone} readOnly />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">4–6. Варианты теста</CardTitle>
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
              {activeVariant > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-surface-muted)] p-2.5">
                  <span className="text-xs font-semibold text-[var(--color-text-muted)]">
                    Скопировать вопросы в вариант {activeVariant + 1}:
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copyVariantFrom(0, activeVariant)}
                  >
                    Из варианта 1
                  </Button>
                  {activeVariant === 2 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => copyVariantFrom(1, 2)}
                    >
                      Из варианта 2
                    </Button>
                  )}
                </div>
              )}
              <nav aria-label="Вопросы теста" className="grid grid-cols-5 gap-2 sm:grid-cols-10">
                {currentVariant?.questions.map((question, index) => (
                  <Button
                    key={question.id}
                    id={`question-step-${index}`}
                    type="button"
                    size="icon"
                    variant={activeQuestion === index ? 'primary' : 'outline'}
                    aria-controls={activeQuestion === index ? `question-panel-${index}` : undefined}
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
                    <Label className="sr-only" htmlFor={`variant-${activeVariant}-question-${activeQuestion}`}>
                      Текст вопроса
                    </Label>
                    <Textarea
          placeholder="Текст вопроса"
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
                              // Question ids are freshly generated on every
                              // render pass, so naming the radio group after one
                              // produced a different attribute on the server and
                              // in the browser and React reported a hydration
                              // mismatch it refused to patch. Position is stable.
                              name={`correct-variant-${activeVariant}-question-${activeQuestion}`}
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
                    <Label className="sr-only" htmlFor={`variant-${activeVariant}-question-${activeQuestion}-explanation`}>
                      Пояснение (необязательно)
                    </Label>
                    <Textarea
          placeholder="Пояснение (необязательно)"
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
              <CardTitle as="h2">7. Проверка перед публикацией</CardTitle>
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
                  <p className="mt-1 font-bold">
                    {validation.completedCount}/{TEST_EDITOR_TOTAL_QUESTIONS} заполнено
                  </p>
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
                  validation.valid && blockers.length === 0
                    ? 'bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]'
                    : 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
                )}
              >
                {!validation.valid
                  ? `Публикация заблокирована: исправьте ${validationMessages.length} ${errorNoun(validationMessages.length)}.`
                  : blockers.length > 0
                    ? `Публикация заблокирована: ${blockers.length} ${REASON_NOUNS[RU_PLURAL_RULES.select(blockers.length)]}.`
                    : 'Курс готов к публикации новой неизменяемой редакции.'}
              </div>
              {!validation.valid && validationAttempted ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-danger)]">
                  {validationMessages.slice(0, 8).map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              ) : null}
              {/* What the other languages lack is known before any attempt, so it
                  is listed at once rather than after a refused publication. */}
              {blockers.length > 0 ? (
                <ul
                  data-course-publication-blockers
                  className="list-disc space-y-1 pl-5 text-sm text-[var(--color-danger)]"
                >
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
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
                  imageLabel="Обложка курса и картинка для соцсетей"
                  imageHint="Эта картинка стоит на карточке курса в каталоге и в предпросмотре ссылки. У пяти базовых курсов обложка встроена в сайт и не меняется."
                  onChange={(seo) => setCourse((current) => ({ ...current, seo }))}
                />
              </div>
            </CardContent>
          </Card>

          {/* Reference material, not an editing step: keep it one click away. */}
          <Card>
            <CardContent className="p-4 md:p-6">
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-semibold">
                  8. История редакций
                  <span className="text-xs font-medium text-[var(--color-text-muted)] tabular-nums">
                    {course.revisionHistory.length}
                  </span>
                </summary>
                <div className="mt-4">
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
                      Опубликованных редакций пока нет.
                    </p>
                  )}
                </div>
              </details>
            </CardContent>
          </Card>
        </fieldset>
      )}
    </EditorShell>
  );
}
