'use client';

import { Plus, Trash } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { AdminLocaleTabs } from '@/components/admin/admin-locale-tabs';
import { ContentBlockEditor } from '@/components/admin/content-block-editor';
import { ContentSeoEditor } from '@/components/admin/content-seo-editor';
import { ArticleRenderer } from '@/components/article-renderer';
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
  type ArticleLocalizationEditorItem,
} from '@/features/admin/localization-contract';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import type { AppLocale } from '@/lib/supabase/types';

type SaveResponse = {
  locale?: AppLocale;
  status?: 'draft' | 'complete';
  draftVersion?: number;
  contentHash?: string;
  error?: string;
};

function statusRecord(items: Record<AppLocale, ArticleLocalizationEditorItem>) {
  return Object.fromEntries(
    ADMIN_CONTENT_LOCALES.map((locale) => [locale, items[locale].status]),
  ) as Record<AppLocale, ArticleLocalizationEditorItem['status']>;
}

function previewFont(locale: AppLocale) {
  return locale === 'zh'
    ? "'SafetyHub Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif"
    : undefined;
}

export function ArticleLocalizationsEditor({
  articleId,
  initial,
}: {
  articleId: string;
  initial: ArticleLocalizationEditorItem[];
}) {
  const initialMap = useMemo(
    () =>
      Object.fromEntries(
        ADMIN_CONTENT_LOCALES.map((locale) => {
          const item = initial.find((entry) => entry.locale === locale);
          if (!item) throw new Error(`ARTICLE_LOCALIZATION_${locale.toUpperCase()}_MISSING`);
          return [locale, structuredClone(item)];
        }),
      ) as Record<AppLocale, ArticleLocalizationEditorItem>,
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

  const updateActive = (update: Partial<ArticleLocalizationEditorItem>) => {
    if (activeLocale === 'ru') return;
    setItems((current) => ({
      ...current,
      [activeLocale]: { ...current[activeLocale], ...update, status: 'draft' },
    }));
    setCompleteRequested(false);
    setMessage('');
  };

  const save = async () => {
    if (activeLocale === 'ru') return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/admin/articles/${encodeURIComponent(articleId)}/localizations/${activeLocale}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locale: activeLocale,
            expectedVersion: active.draftVersion,
            title: active.title,
            description: active.description,
            blocks: active.blocks,
            seo: active.seo,
            sources: active.sources,
            complete: completeRequested,
          }),
        },
      );
      const payload = await readClientResponseJson<SaveResponse>(result.response);
      if (!result.ok || !payload?.draftVersion || !payload.contentHash || !payload.status) {
        const fallback =
          payload?.error === 'CONFLICT' || payload?.error === 'ARTICLE_LOCALIZATION_CONFLICT'
            ? 'Локализацию уже изменили в другой вкладке. Обновите страницу.'
            : 'Не удалось сохранить локализацию. Проверьте поля и повторите.';
        setError(
          payload?.error
            ? fallback
            : clientRequestMessage(
                result.ok ? new Error('INVALID_RESPONSE') : result.error,
                fallback,
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
      setError(
        clientRequestMessage(saveError, 'Не удалось сохранить локализацию. Повторите попытку.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-admin-article-localizations>
      <CardHeader>
        <CardTitle>Локализации статьи</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <AdminLocaleTabs
          idPrefix="article-localization"
          activeLocale={activeLocale}
          statuses={statusRecord(items)}
          onChange={(locale) => {
            setActiveLocale(locale);
            setPreview(false);
            setCompleteRequested(
              items[locale].status === 'complete' || items[locale].status === 'published',
            );
            setMessage('');
            setError('');
          }}
        />

        <section
          id={`article-localization-panel-${activeLocale}`}
          role="tabpanel"
          aria-labelledby={`article-localization-tab-${activeLocale}`}
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
            <article
              lang={activeLocale === 'zh' ? 'zh-Hans' : activeLocale}
              style={{ fontFamily: previewFont(activeLocale) }}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:p-7"
            >
              <Badge variant="sapphire">Предпросмотр · {ADMIN_LOCALE_LABELS[activeLocale]}</Badge>
              <h3 className="mt-3 text-3xl font-black break-words">
                {active.title || 'Без заголовка'}
              </h3>
              <p className="mt-2 mb-6 break-words text-[var(--color-text-muted)]">
                {active.description}
              </p>
              <ArticleRenderer blocks={active.blocks} />
            </article>
          ) : activeLocale === 'ru' ? (
            <div className="rounded-xl border border-[var(--color-border)] p-3.5 text-xs text-[var(--color-text-muted)]">
              Основной текст на русском языке заполняется во вкладке «Содержание статьи».
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor={`article-localization-title-${activeLocale}`}>Заголовок</Label>
                  <Input
                    id={`article-localization-title-${activeLocale}`}
                    maxLength={200}
                    value={active.title}
                    onChange={(event) => updateActive({ title: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor={`article-localization-description-${activeLocale}`}>
                    Описание
                  </Label>
                  <Textarea
                    id={`article-localization-description-${activeLocale}`}
                    maxLength={2_000}
                    value={active.description}
                    onChange={(event) => updateActive({ description: event.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <h3 className="font-bold">Содержание</h3>
                <ContentBlockEditor
                  blocks={active.blocks}
                  onChange={(blocks) => updateActive({ blocks })}
                />
              </div>

              <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
                <h3 className="font-bold">SEO</h3>
                <ContentSeoEditor
                  idPrefix={`article-localization-${activeLocale}`}
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

              <label className="flex min-h-11 items-center gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={completeRequested}
                  onChange={(event) => setCompleteRequested(event.target.checked)}
                />
                Пометить локализацию готовой после сохранения
              </label>
              <Button type="button" disabled={busy} onClick={() => void save()}>
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
