'use client';

import { useUnsavedChangesGuard } from '@/components/admin/use-unsaved-changes-guard';
import { Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArticleRenderer } from '@/components/article-renderer';
import { AdminLocaleTabs } from '@/components/admin/admin-locale-tabs';
import { ContentSeoEditor } from '@/components/admin/content-seo-editor';
import { withCourseSeoDefaults } from '@/lib/validation/course-seo-defaults';
import { CourseContentEditor } from '@/components/admin/course-content-editor';
import { CoursePresentationInput } from '@/components/admin/course-presentation-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  COURSE_UNSAVED_LOCALES_EVENT,
  courseLocaleGaps,
  courseLocaleState,
} from '@/lib/admin/course-readiness';
import {
  ADMIN_CONTENT_LOCALES,
  ADMIN_LOCALE_LABELS,
  type CourseLocalizationEditorItem,
} from '@/lib/admin/localization-contract';
import type { AdminPresentation } from '@/lib/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import {
  defaultCourseContent,
  courseContentSchema,
  type CourseContent,
} from '@/lib/validation/course';
import type { AppLocale } from '@/lib/supabase/types';

type SaveResponse = {
  locale?: AppLocale;
  status?: 'draft' | 'complete';
  draftVersion?: number;
  contentHash?: string;
  error?: string;
};

type ItemMap = Record<AppLocale, CourseLocalizationEditorItem>;

function cloneItem(item: CourseLocalizationEditorItem): CourseLocalizationEditorItem {
  return structuredClone(item);
}

function byLocale<T>(value: (locale: AppLocale) => T) {
  return Object.fromEntries(
    ADMIN_CONTENT_LOCALES.map((locale) => [locale, value(locale)]),
  ) as Record<AppLocale, T>;
}

function itemMap(initial: CourseLocalizationEditorItem[]): ItemMap {
  return byLocale((locale) => {
    const item = initial.find((entry) => entry.locale === locale);
    if (!item) throw new Error(`COURSE_LOCALIZATION_${locale.toUpperCase()}_MISSING`);
    // Localizations inherited the same empty SEO object as their course, so
    // every language showed blank fields and the public pages fell back to a
    // bare one-word title. Fill the gaps from this locale's own title and
    // description; anything already written wins. What is offered here is not
    // stored until the locale is saved — `seoStored` keeps saying so.
    const clone = cloneItem(item);
    return {
      ...clone,
      seo: withCourseSeoDefaults(locale, clone.title, clone.description, clone.seo),
    };
  });
}

function saveErrorMessage(code: string) {
  switch (code) {
    case 'COURSE_LOCALIZATION_ASSESSMENT_REQUIRED':
      return 'Сначала импортируйте локализованные вопросы защищённой серверной командой.';
    case 'COURSE_LOCALIZATION_CONFLICT':
    case 'CONFLICT':
      return 'Локализацию уже изменили в другой вкладке. Обновите страницу.';
    case 'PRESENTATION_NOT_READY':
      return 'Для этого языка нужна проверенная PDF-презентация.';
    case 'RATE_LIMITED':
      return 'Слишком много сохранений подряд. Подождите немного и повторите.';
    default:
      return 'Не удалось сохранить локализацию. Проверьте поля и повторите.';
  }
}

function previewFont(locale: AppLocale) {
  return locale === 'zh'
    ? "'SafetyHub Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif"
    : undefined;
}

function CourseLocalizationPreview({ item }: { item: CourseLocalizationEditorItem }) {
  const content = courseContentSchema.safeParse(item.content);
  return (
    <article
      lang={item.locale === 'zh' ? 'zh-Hans' : item.locale}
      style={{ fontFamily: previewFont(item.locale) }}
      className="space-y-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:p-6"
    >
      <header>
        <Badge variant="sapphire">Предпросмотр · {ADMIN_LOCALE_LABELS[item.locale]}</Badge>
        <h3 className="mt-3 text-2xl font-black break-words">{item.title || 'Без названия'}</h3>
        <p className="mt-2 break-words text-[var(--color-text-muted)]">{item.description}</p>
      </header>
      {content.success ? (
        content.data.modules.map((module) => (
          <section key={module.id} className="space-y-4">
            <h4 className="text-xl font-bold break-words">{module.title}</h4>
            {module.lessons.map((lesson) => (
              <div
                key={lesson.id}
                className="space-y-3 rounded-xl bg-[var(--color-surface-muted)] p-4"
              >
                <h5 className="font-bold break-words">{lesson.title}</h5>
                <ArticleRenderer blocks={lesson.blocks} />
              </div>
            ))}
          </section>
        ))
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">
          Структурированный материал курса пока не заполнен.
        </p>
      )}
    </article>
  );
}

export function CourseLocalizationsEditor({
  courseId,
  initial,
}: {
  courseId: string;
  initial: CourseLocalizationEditorItem[];
}) {
  const router = useRouter();
  const initialMap = useMemo(() => itemMap(initial), [initial]);
  const [items, setItems] = useState(initialMap);
  // What the server holds for each locale. The form is compared with it tab by
  // tab — one fingerprint for all four used to call every tab saved as soon as
  // one of them was — and readiness is judged by it alone, so the list of gaps
  // stays put while a field above it is being typed into.
  const [savedItems, setSavedItems] = useState(initialMap);
  const unsaved = useMemo(
    () =>
      byLocale((locale) => JSON.stringify(items[locale]) !== JSON.stringify(savedItems[locale])),
    [items, savedItems],
  );
  const unsavedLocales = ADMIN_CONTENT_LOCALES.filter((locale) => unsaved[locale]).join(',');
  // The two editors beside this one already refuse to leave with unsaved work.
  // Here a stray click on the sidebar discarded a translation with no warning.
  // Nothing here navigates on its own, so the approval callback is unused.
  useUnsavedChangesGuard(unsavedLocales !== '');

  // `router.refresh()` after a save — here or in the course form above — brings
  // fresh rows. A tab with unsaved work keeps its text and takes only the
  // counts the server owns; every other tab, the read-only Russian one
  // included, is replaced, or it would go on showing the state before the save.
  const seededRef = useRef(initialMap);
  useEffect(() => {
    if (seededRef.current === initialMap) return;
    seededRef.current = initialMap;
    const refreshed = (current: ItemMap) =>
      byLocale((locale) => {
        const fresh = initialMap[locale];
        return unsaved[locale]
          ? {
              ...current[locale],
              assessment: fresh.assessment,
              assessmentGaps: fresh.assessmentGaps,
              assessmentImported: fresh.assessmentImported,
            }
          : fresh;
      });
    setItems(refreshed);
    setSavedItems(refreshed);
  }, [initialMap, unsaved]);

  // The course form above publishes; it cannot see these tabs, and publishing
  // over unsaved work here would quietly leave that work out of the revision.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(COURSE_UNSAVED_LOCALES_EVENT, {
        detail: unsavedLocales ? unsavedLocales.split(',') : [],
      }),
    );
  }, [unsavedLocales]);
  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent(COURSE_UNSAVED_LOCALES_EVENT, { detail: [] }));
    },
    [],
  );

  const readiness = useMemo(
    () =>
      byLocale((locale) => {
        // Listed under the language's own tab, so the lines do not name it again.
        const gaps = courseLocaleGaps(savedItems[locale], savedItems.ru, 'bare');
        return {
          gaps,
          state: courseLocaleState({ ...savedItems[locale], unsaved: unsaved[locale] }, gaps),
        };
      }),
    [savedItems, unsaved],
  );
  const [activeLocale, setActiveLocale] = useState<AppLocale>('ru');
  const [preview, setPreview] = useState(false);
  const [completeRequested, setCompleteRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const active = items[activeLocale];
  const assessmentImported = active.assessmentImported;
  const parsedContent = courseContentSchema.safeParse(active.content);

  const updateActive = (update: Partial<CourseLocalizationEditorItem>) => {
    if (activeLocale === 'ru') return;
    setItems((current) => ({
      ...current,
      [activeLocale]: {
        ...current[activeLocale],
        ...update,
        status: 'draft',
      },
    }));
    // Any text or asset change invalidates the previous review decision. The
    // administrator must explicitly mark the changed localization complete
    // again before the second, hash-confirming save.
    setCompleteRequested(false);
    setMessage('');
  };

  const save = async () => {
    // The tab can change and the fields stay editable while the request runs:
    // what was sent is what becomes the saved state, under the locale it was
    // sent for.
    const locale = activeLocale;
    const sent = active;
    const presentationId = sent.presentation?.id;
    if (locale === 'ru' || !presentationId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/admin/courses/${encodeURIComponent(courseId)}/localizations/${locale}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locale,
            expectedVersion: sent.draftVersion,
            title: sent.title,
            description: sent.description,
            content: sent.content,
            seo: sent.seo,
            sources: sent.sources,
            presentationId,
            complete: completeRequested,
          }),
        },
      );
      const payload = await readClientResponseJson<SaveResponse>(result.response);
      if (!result.ok || !payload?.draftVersion || !payload.contentHash || !payload.status) {
        const code = payload?.error ?? '';
        setError(
          code
            ? saveErrorMessage(code)
            : clientRequestMessage(
                result.ok ? new Error('INVALID_RESPONSE') : result.error,
                saveErrorMessage(''),
              ),
        );
        return;
      }
      const stored = {
        status: payload.status,
        draftVersion: payload.draftVersion,
        contentHash: payload.contentHash,
        reviewedContentHash: payload.status === 'complete' ? payload.contentHash : null,
        // The offered SEO is stored from now on.
        seoStored: { title: sent.seo.title, description: sent.seo.description },
      };
      // Only what the server decided is merged into the form, on top of whatever
      // it holds now; the saved state is what was sent.
      setItems((current) => ({ ...current, [locale]: { ...current[locale], ...stored } }));
      setSavedItems((current) => ({ ...current, [locale]: { ...sent, ...stored } }));
      setMessage(
        payload.status === 'complete'
          ? 'Локализация сохранена и отмечена готовой.'
          : 'Черновик локализации сохранён.',
      );
      // The course form above lists what blocks publication from the saved rows.
      router.refresh();
    } catch (saveError) {
      setError(clientRequestMessage(saveError, saveErrorMessage('')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-admin-course-localizations>
      <CardHeader>
        <CardTitle as="h2">Локализации курса</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <AdminLocaleTabs
          idPrefix="course-localization"
          activeLocale={activeLocale}
          statuses={byLocale((locale) => items[locale].status)}
          badges={byLocale((locale) => readiness[locale].state)}
          onChange={(locale) => {
            setActiveLocale(locale);
            setPreview(false);
            setCompleteRequested(
              items[locale].status === 'complete' || items[locale].status === 'published',
            );
            setError('');
            setMessage('');
          }}
        />

        <section
          id={`course-localization-panel-${activeLocale}`}
          role="tabpanel"
          aria-labelledby={`course-localization-tab-${activeLocale}`}
          className="space-y-5"
        >
          <div className="rounded-xl bg-[var(--color-surface-muted)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Badge variant={readiness[activeLocale].state.variant}>
                {readiness[activeLocale].state.label}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPreview((value) => !value)}
              >
                {preview ? 'Вернуться к полям' : 'Предпросмотр языка'}
              </Button>
            </div>
            {readiness[activeLocale].gaps.length > 0 ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                {readiness[activeLocale].gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {preview ? (
            <CourseLocalizationPreview item={active} />
          ) : activeLocale === 'ru' ? (
            <div className="rounded-xl border border-[var(--color-border)] p-4 text-sm leading-6">
              Русская локализация синхронизируется из основной формы курса выше. В этой вкладке она
              доступна только для контроля статуса и предпросмотра — это исключает расхождение с
              каноническим банком вопросов.
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="sr-only" htmlFor={`course-localization-title-${activeLocale}`}>Название</Label>
                  <Input
          placeholder="Название"
                    id={`course-localization-title-${activeLocale}`}
                    maxLength={200}
                    value={active.title}
                    onChange={(event) => updateActive({ title: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="sr-only" htmlFor={`course-localization-description-${activeLocale}`}>
                    Описание
                  </Label>
                  <Textarea
          placeholder="Описание"
                    id={`course-localization-description-${activeLocale}`}
                    maxLength={2_000}
                    value={active.description}
                    onChange={(event) => updateActive({ description: event.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <h3 className="font-bold">Учебный материал</h3>
                {parsedContent.success ? (
                  <CourseContentEditor
                    value={parsedContent.data}
                    onChange={(content: CourseContent) => updateActive({ content })}
                  />
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      updateActive({
                        content: defaultCourseContent(active.title, active.description),
                      })
                    }
                  >
                    <Plus /> Начать заполнение материала
                  </Button>
                )}
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <h3 className="font-bold">SEO</h3>
                <ContentSeoEditor
                  idPrefix={`course-localization-${activeLocale}`}
                  value={active.seo}
                  onChange={(seo) => updateActive({ seo })}
                />
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold">Источники</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={active.sources.length >= 10}
                    onClick={() =>
                      updateActive({ sources: [...active.sources, { title: '', url: '' }] })
                    }
                  >
                    <Plus /> Добавить
                  </Button>
                </div>
                {active.sources.map((source, index) => (
                  <div
                    key={`${activeLocale}-source-${index}`}
                    className="grid gap-2 md:grid-cols-[1fr_1.5fr_auto]"
                  >
                    <Input
                      aria-label={`Название источника ${index + 1}`}
                      maxLength={240}
                      value={source.title}
                      onChange={(event) =>
                        updateActive({
                          sources: active.sources.map((item, sourceIndex) =>
                            sourceIndex === index ? { ...item, title: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <Input
                      aria-label={`HTTPS-ссылка источника ${index + 1}`}
                      maxLength={2_048}
                      value={source.url}
                      onChange={(event) =>
                        updateActive({
                          sources: active.sources.map((item, sourceIndex) =>
                            sourceIndex === index ? { ...item, url: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Удалить источник ${index + 1}`}
                      onClick={() =>
                        updateActive({
                          sources: active.sources.filter((_, sourceIndex) => sourceIndex !== index),
                        })
                      }
                    >
                      <Trash />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <h3 className="font-bold">Презентация · {ADMIN_LOCALE_LABELS[activeLocale]}</h3>
                <CoursePresentationInput
                  courseId={courseId}
                  locale={activeLocale}
                  value={active.presentation as AdminPresentation | null}
                  onChange={(presentation) => updateActive({ presentation })}
                />
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold">Вопросы и ответы</h3>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      {active.assessment
                        ? `${active.assessment.variantCount} варианта · ${active.assessment.questionCounts.join(' / ')} вопросов`
                        : 'Локализованный банк вопросов ещё не импортирован.'}
                    </p>
                    <p className="text-xs text-[var(--color-text-subtle)]">
                      Версия черновика для offline-импорта: {active.draftVersion ?? 'не создан'}
                    </p>
                  </div>
                  <Badge variant={assessmentImported ? 'success' : 'warning'}>
                    {assessmentImported ? 'Импорт подтверждён' : 'Нужен защищённый импорт'}
                  </Badge>
                </div>
                <p
                  data-course-localization-key-boundary
                  className="text-sm leading-6 text-[var(--color-text-muted)]"
                >
                  Браузер не получает идентификаторы вариантов, вопросы из сохранённого банка или
                  ключи правильных ответов. Переведённый банк загружается только серверной
                  offline-командой; после импорта здесь отображаются лишь контрольные количества и
                  статус.
                </p>
              </div>

              <label className="flex min-h-11 items-center gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={completeRequested}
                  disabled={!assessmentImported}
                  onChange={(event) => setCompleteRequested(event.target.checked)}
                />
                Пометить локализацию готовой после сохранения
              </label>

              <Button
                type="button"
                disabled={busy || !active.presentation?.id}
                onClick={() => void save()}
              >
                {busy ? 'Сохраняем…' : 'Сохранить локализацию'}
              </Button>
            </div>
          )}
        </section>

        {message ? (
          <p role="status" className="text-sm text-[var(--color-text-muted)]">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
