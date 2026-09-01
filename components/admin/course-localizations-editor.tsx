'use client';

import { Plus, Trash } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { ArticleRenderer } from '@/components/article-renderer';
import { AdminLocaleTabs } from '@/components/admin/admin-locale-tabs';
import { ContentSeoEditor } from '@/components/admin/content-seo-editor';
import { CourseContentEditor } from '@/components/admin/course-content-editor';
import { CoursePresentationInput } from '@/components/admin/course-presentation-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  ADMIN_CONTENT_LOCALES,
  ADMIN_LOCALE_LABELS,
  ADMIN_LOCALIZATION_STATUS_LABELS,
  type CourseLocalizationEditorItem,
} from '@/features/admin/localization-contract';
import type { AdminPresentation } from '@/features/admin/types';
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

function cloneItem(item: CourseLocalizationEditorItem): CourseLocalizationEditorItem {
  return structuredClone(item);
}

function statusRecord(items: Record<AppLocale, CourseLocalizationEditorItem>) {
  return Object.fromEntries(
    ADMIN_CONTENT_LOCALES.map((locale) => [locale, items[locale].status]),
  ) as Record<AppLocale, CourseLocalizationEditorItem['status']>;
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
  const initialMap = useMemo(
    () =>
      Object.fromEntries(
        ADMIN_CONTENT_LOCALES.map((locale) => {
          const item = initial.find((entry) => entry.locale === locale);
          if (!item) throw new Error(`COURSE_LOCALIZATION_${locale.toUpperCase()}_MISSING`);
          return [locale, cloneItem(item)];
        }),
      ) as Record<AppLocale, CourseLocalizationEditorItem>,
    [initial],
  );
  const [items, setItems] = useState(initialMap);
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
    if (activeLocale === 'ru' || !active.presentation?.id) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/admin/courses/${encodeURIComponent(courseId)}/localizations/${activeLocale}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locale: activeLocale,
            expectedVersion: active.draftVersion,
            title: active.title,
            description: active.description,
            content: active.content,
            seo: active.seo,
            sources: active.sources,
            presentationId: active.presentation.id,
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
      setItems((current) => ({
        ...current,
        [activeLocale]: {
          ...current[activeLocale],
          status: payload.status!,
          draftVersion: payload.draftVersion!,
          contentHash: payload.contentHash!,
          reviewedContentHash: payload.status === 'complete' ? payload.contentHash! : null,
        },
      }));
      setMessage(
        payload.status === 'complete'
          ? 'Локализация сохранена и отмечена готовой.'
          : 'Черновик локализации сохранён.',
      );
    } catch (saveError) {
      setError(clientRequestMessage(saveError, saveErrorMessage('')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-admin-course-localizations>
      <CardHeader>
        <CardTitle>Локализации курса</CardTitle>
        <p className="text-sm text-[var(--color-text-muted)]">
          Русские подписи админки не меняются. Публикация создаёт одну редакцию только после
          готовности RU, KK, EN и ZH.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <AdminLocaleTabs
          idPrefix="course-localization"
          activeLocale={activeLocale}
          statuses={statusRecord(items)}
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
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3">
            <p className="text-sm">
              Статус: <strong>{ADMIN_LOCALIZATION_STATUS_LABELS[active.status]}</strong>
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPreview((value) => !value)}
            >
              {preview ? 'Вернуться к полям' : 'Предпросмотр языка'}
            </Button>
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
                  <Label htmlFor={`course-localization-title-${activeLocale}`}>Название</Label>
                  <Input
                    id={`course-localization-title-${activeLocale}`}
                    maxLength={200}
                    value={active.title}
                    onChange={(event) => updateActive({ title: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor={`course-localization-description-${activeLocale}`}>
                    Описание
                  </Label>
                  <Textarea
                    id={`course-localization-description-${activeLocale}`}
                    maxLength={2_000}
                    value={active.description}
                    onChange={(event) => updateActive({ description: event.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <div>
                  <h3 className="font-bold">Учебный материал</h3>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    Идентификаторы модулей и уроков сохраняются вместе с локализованным текстом.
                  </p>
                </div>
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
                  <div>
                    <h3 className="font-bold">Источники</h3>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      Названия источников локализуются, HTTPS-ссылки остаются точными.
                    </p>
                  </div>
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
