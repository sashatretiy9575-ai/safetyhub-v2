'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash } from '@phosphor-icons/react';
import { ArticleRenderer } from '@/components/article-renderer';
import { ContentBlockEditor } from '@/components/admin/content-block-editor';
import { ContentSeoEditor } from '@/components/admin/content-seo-editor';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  deleteArticleAction,
  publishArticleAction,
  saveArticleAction,
  setArticleStatusAction,
} from '@/lib/actions/articles';
import type { Article, ArticleBlock, ArticlePublicationState } from '@/lib/content/articles';
import {
  articleBlockSchema,
  articleBlocksSchema,
  type ArticleLifecycleStatus,
} from '@/lib/validation/article';
import { defaultContentSeo } from '@/lib/validation/content-seo';
import { MediaAssetInput } from '@/components/admin/media-asset-input';
import { EditorActionBar } from '@/components/admin/editor-action-bar';
import { EditorShell } from '@/components/admin/editor-shell';
import { useUnsavedChangesGuard } from '@/components/admin/use-unsaved-changes-guard';
import { DestructiveDialog } from '@/components/admin/destructive-dialog';
import {
  CONTENT_METADATA_LIMITS,
  toContentDateInput,
  type ContentSource,
} from '@/lib/content/content-metadata';
import { clearEditorDraft, readEditorDraft, writeEditorDraft } from '@/lib/editor-drafts';
import { ArticleLocalizationsEditor } from '@/components/admin/article-localizations-editor';
import type { ArticleLocalizationEditorItem } from '@/features/admin/localization-contract';

type ArticleLocalDraft = {
  id: string | null;
  draftVersion?: number;
  originalSlug: string | null;
  slug: string;
  title: string;
  description: string;
  coverImage: string;
  seo: ReturnType<typeof defaultContentSeo>;
  jurisdiction: string;
  effectiveDate: string;
  sources: ContentSource[];
  blocks: ArticleBlock[];
};

function isArticleLocalDraft(value: unknown): value is ArticleLocalDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Partial<ArticleLocalDraft>;
  return (
    (draft.id === null || typeof draft.id === 'string') &&
    (draft.originalSlug === null || typeof draft.originalSlug === 'string') &&
    typeof draft.slug === 'string' &&
    typeof draft.title === 'string' &&
    typeof draft.description === 'string' &&
    typeof draft.coverImage === 'string' &&
    Boolean(draft.seo && typeof draft.seo === 'object') &&
    typeof draft.jurisdiction === 'string' &&
    typeof draft.effectiveDate === 'string' &&
    Array.isArray(draft.sources) &&
    draft.sources.every(
      (source) =>
        Boolean(source) && typeof source.title === 'string' && typeof source.url === 'string',
    ) &&
    Array.isArray(draft.blocks)
  );
}

const PUBLICATION_LABEL: Record<ArticlePublicationState, string> = {
  never_published: 'Ещё не публиковалась',
  draft: 'Снята с публикации',
  published: 'Опубликована',
  published_with_draft_changes: 'Опубликована',
};

function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function AdminEditor({
  initialData,
  initialLocalizations,
  initialPublicationNotice = null,
}: {
  initialData?: Article;
  initialLocalizations?: ArticleLocalizationEditorItem[];
  initialPublicationNotice?: 'incomplete' | 'failed' | null;
}) {
  const router = useRouter();
  const editorIdRef = useRef(initialData?.id ?? 'new');
  const initialBlocks = articleBlocksSchema.safeParse(initialData?.blocks ?? []);
  const [articleId, setArticleId] = useState(initialData?.id ?? null);
  const [draftVersion, setDraftVersion] = useState(initialData?.draftVersion);
  const [originalSlug, setOriginalSlug] = useState(initialData?.originalSlug ?? null);
  const [slug, setSlug] = useState(initialData?.slug ?? '');
  const [title, setTitle] = useState(initialData?.title ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [coverImage, setCoverImage] = useState(initialData?.coverImage ?? '');
  const [seo, setSeo] = useState(
    initialData?.seo ??
      defaultContentSeo(
        initialData?.title ?? '',
        initialData?.description ?? '',
        initialData?.coverImage ?? '',
      ),
  );
  const [jurisdiction, setJurisdiction] = useState(initialData?.jurisdiction ?? '');
  const [effectiveDate, setEffectiveDate] = useState(
    toContentDateInput(initialData?.effectiveDate ?? ''),
  );
  const [sources, setSources] = useState<ContentSource[]>(initialData?.sources ?? []);
  const [blocks, setBlocks] = useState<ArticleBlock[]>(
    initialBlocks.success ? initialBlocks.data : [],
  );
  const [status, setStatus] = useState<ArticleLifecycleStatus>(initialData?.status ?? 'draft');
  const [publicationState, setPublicationState] = useState<ArticlePublicationState>(
    initialData?.publicationState ?? 'never_published',
  );
  const [publishedContentHash, setPublishedContentHash] = useState<string | null>(
    initialData?.publishedContentHash ?? null,
  );
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    initialPublicationNotice === 'incomplete'
      ? 'Черновик сохранён, но публикация заблокирована: подготовьте RU, KK, EN и ZH.'
      : initialPublicationNotice === 'failed'
        ? 'Черновик сохранён, но четыре локализации опубликовать не удалось.'
        : '',
  );
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving'>('saved');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const previewBlocks = useMemo(
    () => blocks.filter((block) => articleBlockSchema.safeParse(block).success),
    [blocks],
  );
  const documentFingerprint = useMemo(
    () =>
      JSON.stringify({
        slug,
        title,
        description,
        coverImage,
        seo,
        jurisdiction,
        effectiveDate,
        sources,
        blocks,
      }),
    [blocks, coverImage, description, effectiveDate, jurisdiction, seo, slug, sources, title],
  );
  const [savedFingerprint, setSavedFingerprint] = useState(documentFingerprint);
  const approveNavigation = useUnsavedChangesGuard(documentFingerprint !== savedFingerprint);
  const localDraft = useMemo<ArticleLocalDraft>(
    () => ({
      id: articleId,
      ...(draftVersion ? { draftVersion } : {}),
      originalSlug,
      slug,
      title,
      description,
      coverImage,
      seo,
      jurisdiction,
      effectiveDate,
      sources,
      blocks,
    }),
    [
      articleId,
      blocks,
      coverImage,
      description,
      draftVersion,
      effectiveDate,
      jurisdiction,
      originalSlug,
      seo,
      slug,
      sources,
      title,
    ],
  );

  useEffect(() => {
    const stored = readEditorDraft(
      window.localStorage,
      'article',
      editorIdRef.current,
      isArticleLocalDraft,
    );
    if (stored && JSON.stringify(stored.payload) !== JSON.stringify(localDraft)) {
      const draft = stored.payload;
      setArticleId(draft.id);
      setDraftVersion(draft.draftVersion);
      setOriginalSlug(draft.originalSlug);
      setSlug(draft.slug);
      setTitle(draft.title);
      setDescription(draft.description);
      setCoverImage(draft.coverImage);
      setSeo({ ...draft.seo });
      setJurisdiction(draft.jurisdiction);
      setEffectiveDate(draft.effectiveDate);
      setSources(draft.sources.map((source) => ({ ...source })));
      setBlocks(structuredClone(draft.blocks));
    }
    setDraftReady(true);
    // The server snapshot is intentionally compared only once during hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    if (documentFingerprint === savedFingerprint) {
      clearEditorDraft(window.localStorage, 'article', editorIdRef.current);
      return;
    }
    const timer = window.setTimeout(() => {
      writeEditorDraft(window.localStorage, 'article', editorIdRef.current, localDraft);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [documentFingerprint, draftReady, localDraft, savedFingerprint]);

  const updateSource = (index: number, update: Partial<ContentSource>) => {
    setSources((current) =>
      current.map((source, sourceIndex) =>
        sourceIndex === index ? { ...source, ...update } : source,
      ),
    );
  };

  const persist = useCallback(async () => {
    const normalizedSlug = normalizeSlug(slug);
    const result = await saveArticleAction({
      id: articleId,
      draftVersion,
      originalSlug,
      slug: normalizedSlug,
      title,
      description,
      coverImage,
      seo,
      jurisdiction,
      effectiveDate,
      sources,
      blocks,
    });
    setArticleId(result.id);
    setDraftVersion(result.draftVersion);
    setOriginalSlug(result.slug);
    setSlug(result.slug);
    setStatus(result.status);
    setPublicationState(
      result.status === 'draft'
        ? publishedContentHash
          ? 'draft'
          : 'never_published'
        : publishedContentHash === result.contentHash
          ? 'published'
          : 'published_with_draft_changes',
    );
    clearEditorDraft(window.localStorage, 'article', editorIdRef.current);
    return result;
  }, [
    articleId,
    blocks,
    coverImage,
    description,
    draftVersion,
    effectiveDate,
    jurisdiction,
    originalSlug,
    publishedContentHash,
    seo,
    slug,
    sources,
    title,
  ]);

  useEffect(() => {
    if (documentFingerprint === savedFingerprint) {
      setSaveState('saved');
      return;
    }
    setSaveState('unsaved');
    const canAutosave =
      normalizeSlug(slug).length > 0 &&
      title.trim().length >= 2 &&
      articleBlocksSchema.safeParse(blocks).success;
    if (!canAutosave || busy) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setSaveState('saving');
      void persist()
        .then((result) => {
          if (cancelled) return;
          setSavedFingerprint(documentFingerprint);
          setSavedAt(new Date());
          setSaveState('saved');
          if (!articleId) router.replace(`/admin/articles/${result.slug}/edit`);
        })
        .catch(() => {
          if (!cancelled) setSaveState('unsaved');
        });
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    articleId,
    blocks,
    busy,
    documentFingerprint,
    persist,
    router,
    savedFingerprint,
    slug,
    title,
  ]);

  const finishNavigation = (nextSlug: string) => {
    approveNavigation();
    router.replace(`/admin/articles/${nextSlug}/edit`);
    router.refresh();
  };

  const handleSave = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await persist();
      setSavedFingerprint(documentFingerprint);
      setSavedAt(new Date());
      setSaveState('saved');
      finishNavigation(result.slug);
    } catch {
      setError('Не удалось сохранить. Проверьте поля, ссылки и содержимое блоков.');
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (nextStatus: ArticleLifecycleStatus) => {
    const confirmation: Record<ArticleLifecycleStatus, string> = {
      draft: 'Снять статью с публикации и оставить её черновиком?',
      published: 'Сохранить изменения и опубликовать статью?',
    };
    if (!window.confirm(confirmation[nextStatus])) return;

    setBusy(true);
    setError('');
    try {
      if (nextStatus === 'published') {
        const result = await publishArticleAction({
          id: articleId,
          draftVersion,
          originalSlug,
          slug: normalizeSlug(slug),
          title,
          description,
          coverImage,
          seo,
          jurisdiction,
          effectiveDate,
          sources,
          blocks,
        });
        setArticleId(result.id);
        setDraftVersion(result.draftVersion);
        setOriginalSlug(result.slug);
        setSlug(result.slug);
        setSavedFingerprint(documentFingerprint);
        setSavedAt(new Date());
        setSaveState('saved');
        clearEditorDraft(window.localStorage, 'article', editorIdRef.current);
        if (result.publicationError) {
          setStatus(result.status);
          setPublicationState(
            result.status === 'published'
              ? 'published_with_draft_changes'
              : publishedContentHash
                ? 'draft'
                : 'never_published',
          );
          setError(
            result.publicationError === 'ARTICLE_LOCALIZATIONS_INCOMPLETE'
              ? 'Черновик сохранён, но публикация заблокирована: подготовьте RU, KK, EN и ZH.'
              : 'Черновик сохранён, но четыре локализации опубликовать не удалось.',
          );
          approveNavigation();
          router.replace(
            `/admin/articles/${result.slug}/edit?publication=${result.publicationError === 'ARTICLE_LOCALIZATIONS_INCOMPLETE' ? 'incomplete' : 'failed'}`,
          );
          router.refresh();
          return;
        }
        setStatus('published');
        setPublishedContentHash(result.contentHash);
        setPublicationState('published');
        finishNavigation(result.slug);
        return;
      }
      const saved = await persist();
      const result = await setArticleStatusAction({
        articleId: saved.id,
        status: nextStatus,
        expectedContentHash: saved.contentHash,
      });
      setDraftVersion(result.draftVersion);
      setStatus(result.status);
      if (result.status === 'published') {
        setPublishedContentHash(result.contentHash);
        setPublicationState('published');
      } else {
        setPublicationState('draft');
      }
      finishNavigation(result.slug);
    } catch (statusError) {
      setError(
        statusError instanceof Error && statusError.message === 'ARTICLE_LOCALIZATIONS_INCOMPLETE'
          ? 'Публикация заблокирована: подготовьте RU, KK, EN и ZH.'
          : 'Не удалось изменить статус статьи. Повторите действие после проверки полей.',
      );
    } finally {
      setBusy(false);
    }
  };

  const displayedPublicationState =
    saveState === 'unsaved' && publicationState === 'published'
      ? 'published_with_draft_changes'
      : publicationState;

  const handleDelete = async () => {
    if (!articleId || !draftVersion) return;
    setBusy(true);
    setError('');
    try {
      await deleteArticleAction({ articleId, expectedVersion: draftVersion });
      clearEditorDraft(window.localStorage, 'article', editorIdRef.current);
      setDeleteOpen(false);
      approveNavigation();
      router.replace('/admin/articles');
      router.refresh();
    } catch {
      setError('Не удалось удалить статью. Обновите страницу и повторите действие.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditorShell>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 shrink-0"
          onClick={() => router.back()}
        >
          Назад
        </Button>
        <div className="min-w-0">
          <h1 className="text-lg leading-tight font-bold break-words md:text-xl">
            {initialData ? 'Редактирование статьи' : 'Новая статья'}
          </h1>
        </div>
      </div>

      <EditorActionBar
        busy={busy}
        preview={preview}
        statusLabel={PUBLICATION_LABEL[displayedPublicationState]}
        published={
          displayedPublicationState === 'published' ||
          displayedPublicationState === 'published_with_draft_changes'
        }
        hasDraftChanges={displayedPublicationState === 'published_with_draft_changes'}
        liveMessage={
          saveState === 'saving'
            ? 'Сохраняем изменения'
            : saveState === 'unsaved'
              ? 'Есть несохранённые изменения'
              : savedAt
                ? `Сохранено в ${savedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                : initialData
                  ? 'Сохранено на сервере'
                  : 'Черновик ещё не сохранён'
        }
        onTogglePreview={() => setPreview((current) => !current)}
        onSave={() => void handleSave()}
        onPublish={() => void handleStatus('published')}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3 text-sm text-[var(--color-danger)]"
        >
          {error}
        </p>
      ) : null}

      <Card>
        <CardContent className="space-y-3 p-4 md:p-6">
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="font-semibold">Публикация</h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                Сохранение не меняет статус и исходную дату публикации.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  displayedPublicationState === 'published' ||
                  displayedPublicationState === 'published_with_draft_changes'
                    ? 'success'
                    : 'default'
                }
              >
                {PUBLICATION_LABEL[displayedPublicationState]}
              </Badge>
              {displayedPublicationState === 'published_with_draft_changes' ? (
                <Badge variant="default">Есть черновик</Badge>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
            {status !== 'published' ? (
              <Button
                type="button"
                className="min-h-11"
                disabled={busy}
                onClick={() => handleStatus('published')}
              >
                Опубликовать
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => handleStatus('draft')}
              >
                Снять с публикации
              </Button>
            )}
            {articleId ? (
              <Button
                type="button"
                variant="danger"
                className="min-h-11"
                disabled={busy || !draftVersion}
                onClick={() => setDeleteOpen(true)}
              >
                Удалить
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {preview ? (
        <Card className="min-w-0 overflow-hidden">
          <CardContent className="min-w-0 p-4 min-[360px]:p-5 md:p-8">
            <h2 className="mb-3 text-2xl font-bold break-words md:text-4xl">
              {title || 'Без заголовка'}
            </h2>
            <p className="mb-6 text-base break-words text-[var(--color-text-muted)] md:mb-8 md:text-xl">
              {description}
            </p>
            {previewBlocks.length !== blocks.length ? (
              <p role="status" className="mb-4 text-sm text-[var(--color-danger)]">
                Незаполненные блоки скрыты из предпросмотра.
              </p>
            ) : null}
            <ArticleRenderer blocks={previewBlocks} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-3 lg:gap-8">
          <div className="min-w-0 space-y-6 lg:order-2 lg:col-span-1">
            <Card className="min-w-0">
              <CardContent className="min-w-0 space-y-4 p-4 min-[360px]:p-5 md:p-6">
                <h2 className="font-semibold">Метаданные</h2>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="article-slug">Slug (URL)</Label>
                  <Input
                    id="article-slug"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    placeholder="my-article-slug"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="article-cover">Обложка из /public/images (необязательно)</Label>
                  <MediaAssetInput
                    id="article-cover"
                    value={coverImage}
                    maxWidth={1600}
                    maxHeight={900}
                    onChange={setCoverImage}
                    placeholder="/images/generated/cover.webp"
                  />
                  <p className="text-xs text-[var(--color-text-subtle)]">
                    Оставьте поле пустым: черновик и опубликованная статья получат компоновку без
                    изображения.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardContent className="min-w-0 space-y-4 p-4 min-[360px]:p-5 md:p-6">
                <h2 className="font-semibold">SEO и соцсети</h2>
                <ContentSeoEditor idPrefix="article" value={seo} onChange={setSeo} />
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardContent className="min-w-0 space-y-4 p-4 min-[360px]:p-5 md:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">Данные материала и источники</h2>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Все поля в этом разделе необязательны и не блокируют публикацию.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="article-jurisdiction">Юрисдикция</Label>
                  <Input
                    id="article-jurisdiction"
                    value={jurisdiction}
                    maxLength={CONTENT_METADATA_LIMITS.jurisdictionMax}
                    onChange={(event) => setJurisdiction(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="article-effective-date">Дата актуальности</Label>
                  <Input
                    id="article-effective-date"
                    type="date"
                    value={effectiveDate}
                    onChange={(event) => setEffectiveDate(event.target.value)}
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Нормативные источники</h3>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={sources.length >= CONTENT_METADATA_LIMITS.sourceCountMax}
                      onClick={() => setSources((current) => [...current, { title: '', url: '' }])}
                    >
                      <Plus aria-hidden="true" /> Добавить
                    </Button>
                  </div>
                  {sources.map((source, sourceIndex) => (
                    <fieldset
                      key={sourceIndex}
                      className="min-w-0 space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
                    >
                      <legend className="px-1 text-xs font-bold">Источник {sourceIndex + 1}</legend>
                      <Label className="sr-only" htmlFor={`article-source-${sourceIndex}-title`}>
                        Название источника {sourceIndex + 1}
                      </Label>
                      <Input
                        id={`article-source-${sourceIndex}-title`}
                        value={source.title}
                        maxLength={CONTENT_METADATA_LIMITS.sourceTitleMax}
                        placeholder="Название документа"
                        onChange={(event) =>
                          updateSource(sourceIndex, { title: event.target.value })
                        }
                      />
                      <Label className="sr-only" htmlFor={`article-source-${sourceIndex}-url`}>
                        HTTPS-ссылка источника {sourceIndex + 1}
                      </Label>
                      <Input
                        id={`article-source-${sourceIndex}-url`}
                        type="url"
                        value={source.url}
                        maxLength={CONTENT_METADATA_LIMITS.sourceUrlMax}
                        placeholder="https://adilet.zan.kz/..."
                        onChange={(event) => updateSource(sourceIndex, { url: event.target.value })}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSources((current) =>
                            current.filter((_, currentIndex) => currentIndex !== sourceIndex),
                          )
                        }
                      >
                        <Trash aria-hidden="true" /> Удалить источник
                      </Button>
                    </fieldset>
                  ))}
                  {sources.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-muted)]">Источники не указаны.</p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="min-w-0 space-y-4 lg:order-1 lg:col-span-2">
            <Card>
              <CardContent className="space-y-4 p-4 md:p-5">
                <div className="space-y-2">
                  <Label htmlFor="article-title">Название статьи</Label>
                  <Input
                    id="article-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Название статьи"
                    className="h-auto border-0 px-0 text-xl font-bold shadow-none focus-visible:ring-0"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="article-description">Краткое описание</Label>
                  <Textarea
                    id="article-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Коротко: о чём этот материал"
                    className="min-h-20"
                  />
                </div>
              </CardContent>
            </Card>
            <Card className="min-w-0 overflow-hidden">
              <CardContent className="space-y-4 p-4 md:p-5">
                <div>
                  <h2 className="font-semibold">Содержание статьи</h2>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    Перетаскивайте блоки за маркер или используйте кнопки вверх и вниз.
                  </p>
                </div>
                <ContentBlockEditor mode="article" blocks={blocks} onChange={setBlocks} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {articleId && initialLocalizations ? (
        <ArticleLocalizationsEditor articleId={articleId} initial={initialLocalizations} />
      ) : articleId ? (
        <Card>
          <CardContent className="p-4 text-sm text-[var(--color-text-muted)]">
            Обновите страницу после первого сохранения, чтобы открыть вкладки RU, KK, EN и ZH.
          </CardContent>
        </Card>
      ) : null}

      <DestructiveDialog
        open={deleteOpen}
        title="Удалить статью?"
        description="Статья, её черновик, ревизии и перенаправления будут удалены. Публичная ссылка начнёт возвращать 404."
        busy={busy}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void handleDelete()}
      />
    </EditorShell>
  );
}
