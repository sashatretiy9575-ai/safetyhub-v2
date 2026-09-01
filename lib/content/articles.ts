import 'server-only';
import fs from 'fs';
import path from 'path';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { ContentSourceError, fallbackAfterContentFailure } from '@/lib/content/fallback-policy';
import {
  ARTICLES_CACHE_TAG,
  CONTENT_CACHE_REVALIDATE_SECONDS,
  CONTENT_CACHE_TAG,
} from '@/lib/content/cache-policy';
import { createPublicClient } from '@/lib/supabase/public';
import { isContentSlug } from '@/lib/content/slug';
import { coerceContentMetadata } from '@/lib/content/content-metadata';
import {
  articleBlocksSchema,
  articleCoverImageSchema,
  articleDocumentMetadataSchema,
  articleDocumentSchema,
  type ArticleBlockInput,
  type ArticleDocumentInput,
  type ArticleLifecycleStatus,
} from '@/lib/validation/article';
import { contentSeoSchema, defaultContentSeo, type ContentSeo } from '@/lib/validation/content-seo';
import { DEFAULT_LOCALE, type AppLocale } from '@/i18n/config';
import type { Json } from '@/lib/supabase/types';

export type ArticleBlock = ArticleBlockInput;
export type ArticlePublicationState =
  | 'never_published'
  | 'draft'
  | 'published'
  | 'published_with_draft_changes';

export type Article = Omit<ArticleDocumentInput, 'blocks'> & {
  blocks: unknown;
  id?: string;
  originalSlug?: string;
  status?: ArticleLifecycleStatus;
  publicationState?: ArticlePublicationState;
  publishedContentHash?: string | null;
  seo?: ContentSeo;
  draftVersion?: number;
  contentHash?: string;
};

const articlesDir = path.join(process.cwd(), 'content', 'articles');
let lastKnownArticles: Omit<Article, 'blocks'>[] | null = null;
const lastKnownArticlesBySlug = new Map<string, Article | null>();
const lastKnownRedirects = new Map<string, string | null>();

function rememberArticle(slug: string, article: Article | null) {
  lastKnownArticlesBySlug.delete(slug);
  lastKnownArticlesBySlug.set(slug, article);
  if (lastKnownArticlesBySlug.size > 128) {
    const oldest = lastKnownArticlesBySlug.keys().next().value;
    if (typeof oldest === 'string') lastKnownArticlesBySlug.delete(oldest);
  }
}

function listArticleFiles() {
  if (!fs.existsSync(articlesDir)) return [];
  return fs.readdirSync(articlesDir).filter((file) => file.endsWith('.json'));
}

export function parseArticleBlocks(value: unknown): ArticleBlock[] {
  return articleBlocksSchema.parse(value);
}

function publicCoverImage(value: unknown) {
  const parsed = articleCoverImageSchema.safeParse(value);
  return parsed.success ? parsed.data : '';
}

function metadataFields(value: Record<string, unknown>) {
  return coerceContentMetadata({
    jurisdiction: value.jurisdiction ?? '',
    effectiveDate: value.effectiveDate ?? value.effective_date ?? '',
    sources: value.sources ?? [],
  });
}

function readLocalArticle(filePath: string, fallbackSlug?: string): Article | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const source =
      fallbackSlug && value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), slug: fallbackSlug }
        : value;
    const legacy = source as Record<string, unknown>;
    const article = articleDocumentSchema.parse({
      slug: legacy.slug,
      title: legacy.title,
      description: legacy.description,
      coverImage: legacy.coverImage,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      publishedAt: legacy.publishedAt,
      author: legacy.author,
      seo: legacy.seo,
      jurisdiction: legacy.jurisdiction ?? '',
      effectiveDate: legacy.effectiveDate ?? '',
      sources: legacy.sources ?? [],
      blocks: legacy.blocks,
    });
    return {
      ...article,
      seo: article.seo ?? defaultContentSeo(article.title, article.description, article.coverImage),
    };
  } catch (error) {
    console.error('LOCAL_ARTICLE_INVALID', {
      article: path.basename(filePath),
      cause: error instanceof Error ? error.message.slice(0, 240) : 'UNKNOWN_VALIDATION_ERROR',
    });
    return null;
  }
}

function getLocalArticles(): Omit<Article, 'blocks'>[] {
  return listArticleFiles()
    .flatMap((file) => {
      const raw = readLocalArticle(path.join(articlesDir, file), file.replace('.json', ''));
      if (!raw) return [];
      const { blocks: _blocks, ...summary } = raw;
      return [{ ...summary, updatedAt: raw.updatedAt ?? raw.createdAt }];
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

async function getArticlesFromSource(): Promise<Omit<Article, 'blocks'>[]> {
  const supabase = createPublicClient();
  if (!supabase) {
    return fallbackAfterContentFailure({
      configured: false,
      fallback: getLocalArticles,
      operation: 'list articles',
    });
  }

  try {
    const { data, error, status } = await supabase
      .from('articles')
      .select(
        'slug,title,description,cover_image,seo,published_at,created_at,updated_at,jurisdiction,effective_date,sources,content_hash',
      )
      .eq('is_published', true)
      .order('published_at', { ascending: false });

    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => lastKnownArticles ?? getLocalArticles(),
        operation: 'list articles',
        status,
      });
    }

    const articles = (data ?? []).map((article) => ({
      slug: article.slug,
      title: article.title,
      description: article.description,
      coverImage: publicCoverImage(article.cover_image),
      seo: contentSeoSchema.safeParse(article.seo).success
        ? contentSeoSchema.parse(article.seo)
        : defaultContentSeo(
            article.title,
            article.description,
            publicCoverImage(article.cover_image),
          ),
      createdAt: article.published_at ?? article.created_at,
      updatedAt: article.updated_at,
      ...metadataFields(article),
    }));
    lastKnownArticles = articles;
    return articles;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownArticles ?? getLocalArticles(),
      operation: 'list articles',
    });
  }
}

const getCachedArticles = unstable_cache(getArticlesFromSource, ['content-articles-v3'], {
  revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
  tags: [CONTENT_CACHE_TAG, ARTICLES_CACHE_TAG],
});

const getLegacyArticles = cache(getCachedArticles);

async function getArticleBySlugFromSource(slug: string): Promise<Article | null> {
  const supabase = createPublicClient();
  const readLocal = () => {
    const filePath = path.join(articlesDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    return readLocalArticle(filePath, slug);
  };

  if (!supabase) {
    return fallbackAfterContentFailure({
      configured: false,
      fallback: readLocal,
      operation: `read article ${slug}`,
    });
  }

  try {
    const { data, error, status } = await supabase
      .from('articles')
      .select(
        'slug,title,description,cover_image,blocks,seo,published_at,created_at,updated_at,jurisdiction,effective_date,sources,content_hash',
      )
      .eq('slug', slug)
      .eq('is_published', true)
      .maybeSingle();

    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () =>
          lastKnownArticlesBySlug.has(slug) ? lastKnownArticlesBySlug.get(slug)! : readLocal(),
        operation: `read article ${slug}`,
        status,
      });
    }

    if (!data) {
      rememberArticle(slug, null);
      return null;
    }
    const parsed = articleDocumentMetadataSchema.safeParse({
      slug: data.slug,
      title: data.title,
      description: data.description,
      coverImage: data.cover_image ?? '',
      createdAt: data.published_at ?? data.created_at,
      updatedAt: data.updated_at,
      publishedAt: data.published_at,
      ...metadataFields(data),
    });
    if (!parsed.success) {
      throw new ContentSourceError({
        error: parsed.error,
        failure: 'backend',
        operation: `validate article ${slug}`,
        status,
      });
    }

    if (!articleBlocksSchema.safeParse(data.blocks).success) {
      console.error('ARTICLE_BLOCKS_INVALID', { slug: data.slug });
    }
    const article: Article = {
      ...parsed.data,
      seo: contentSeoSchema.safeParse(data.seo).success
        ? contentSeoSchema.parse(data.seo)
        : defaultContentSeo(data.title, data.description, publicCoverImage(data.cover_image)),
      blocks: data.blocks,
      contentHash: data.content_hash,
    };
    rememberArticle(slug, article);
    return article;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () =>
        lastKnownArticlesBySlug.has(slug) ? lastKnownArticlesBySlug.get(slug)! : readLocal(),
      operation: `read article ${slug}`,
    });
  }
}

const getCachedArticleBySlug = unstable_cache(getArticleBySlugFromSource, ['content-article-v3'], {
  revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
  tags: [CONTENT_CACHE_TAG, ARTICLES_CACHE_TAG],
});

const getLegacyArticleBySlug = cache((slug: string) =>
  isContentSlug(slug) ? getCachedArticleBySlug(slug) : Promise.resolve(null),
);

type LocalizedArticleRpcClient = {
  rpc(
    name: 'list_published_articles_locale' | 'get_published_article_locale',
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: Json;
    error: { code?: string; message?: string } | null;
    status: number;
  }>;
};

const lastKnownLocalizedArticles = new Map<AppLocale, Omit<Article, 'blocks'>[]>();
const lastKnownLocalizedArticlesBySlug = new Map<string, Article | null>();

function localizedArticleKey(locale: AppLocale, slug: string) {
  return `${locale}:${slug}`;
}

function localizedArticleSummary(value: Record<string, unknown>): Omit<Article, 'blocks'> | null {
  if (
    typeof value.slug !== 'string' ||
    !isContentSlug(value.slug) ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string'
  ) {
    return null;
  }
  const coverImage = publicCoverImage(value.coverImage);
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    slug: value.slug,
    title: value.title,
    description: value.description,
    coverImage,
    createdAt: typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
    updatedAt: typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
    seo: contentSeoSchema.safeParse(value.seo).success
      ? contentSeoSchema.parse(value.seo)
      : defaultContentSeo(value.title, value.description, coverImage),
    ...metadataFields(value),
  };
}

async function getLocalizedArticlesFromSource(locale: AppLocale) {
  const supabase = createPublicClient();
  if (!supabase) return getLegacyArticles();
  try {
    const { data, error, status } = await (supabase as unknown as LocalizedArticleRpcClient).rpc(
      'list_published_articles_locale',
      { p_locale: locale, p_limit: 50 },
    );
    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => lastKnownLocalizedArticles.get(locale) ?? [],
        operation: `list ${locale} articles`,
        status,
      });
    }
    const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const items = raw && 'items' in raw && Array.isArray(raw.items) ? raw.items : [];
    const articles = items.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const article = localizedArticleSummary(item as Record<string, unknown>);
      return article ? [article] : [];
    });
    lastKnownLocalizedArticles.set(locale, articles);
    return articles;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownLocalizedArticles.get(locale) ?? [],
      operation: `list ${locale} articles`,
    });
  }
}

const getCachedLocalizedArticles = unstable_cache(
  getLocalizedArticlesFromSource,
  ['content-articles-localized-v1'],
  {
    revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
    tags: [CONTENT_CACHE_TAG, ARTICLES_CACHE_TAG],
  },
);

export const getArticles = cache((locale: AppLocale = DEFAULT_LOCALE) =>
  getCachedLocalizedArticles(locale),
);

async function getLocalizedArticleBySlugFromSource(slug: string, locale: AppLocale) {
  const supabase = createPublicClient();
  if (!supabase) return getLegacyArticleBySlug(slug);
  const key = localizedArticleKey(locale, slug);
  try {
    const { data, error, status } = await (supabase as unknown as LocalizedArticleRpcClient).rpc(
      'get_published_article_locale',
      { p_slug: slug, p_locale: locale },
    );
    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => lastKnownLocalizedArticlesBySlug.get(key) ?? null,
        operation: `read ${locale} article ${slug}`,
        status,
      });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const raw = data as Record<string, unknown>;
    const summary = localizedArticleSummary(raw);
    if (!summary || !articleBlocksSchema.safeParse(raw.blocks).success) return null;
    const article: Article = { ...summary, blocks: raw.blocks };
    lastKnownLocalizedArticlesBySlug.set(key, article);
    return article;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownLocalizedArticlesBySlug.get(key) ?? null,
      operation: `read ${locale} article ${slug}`,
    });
  }
}

const getCachedLocalizedArticleBySlug = unstable_cache(
  getLocalizedArticleBySlugFromSource,
  ['content-article-localized-v1'],
  {
    revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
    tags: [CONTENT_CACHE_TAG, ARTICLES_CACHE_TAG],
  },
);

export const getArticleBySlug = cache((slug: string, locale: AppLocale = DEFAULT_LOCALE) =>
  isContentSlug(slug)
    ? getCachedLocalizedArticleBySlug(slug, locale)
    : Promise.resolve(null),
);

type ArticleRedirectClient = {
  rpc(
    name: 'resolve_article_slug',
    args: { p_old_slug: string },
  ): PromiseLike<{
    data: string | null;
    error: { code?: string; message?: string } | null;
    status: number;
  }>;
};

async function getArticleRedirectBySlugFromSource(slug: string): Promise<string | null> {
  const supabase = createPublicClient();
  if (!supabase) return null;

  try {
    const { data, error, status } = await (supabase as unknown as ArticleRedirectClient).rpc(
      'resolve_article_slug',
      { p_old_slug: slug },
    );
    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => lastKnownRedirects.get(slug) ?? null,
        operation: `resolve article redirect ${slug}`,
        status,
      });
    }
    lastKnownRedirects.set(slug, data);
    if (lastKnownRedirects.size > 128) {
      const oldest = lastKnownRedirects.keys().next().value;
      if (typeof oldest === 'string') lastKnownRedirects.delete(oldest);
    }
    return data;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownRedirects.get(slug) ?? null,
      operation: `resolve article redirect ${slug}`,
    });
  }
}

const getCachedArticleRedirectBySlug = unstable_cache(
  getArticleRedirectBySlugFromSource,
  ['content-article-redirect-v2'],
  {
    revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
    tags: [CONTENT_CACHE_TAG, ARTICLES_CACHE_TAG],
  },
);

export const getArticleRedirectBySlug = cache((slug: string) =>
  isContentSlug(slug) ? getCachedArticleRedirectBySlug(slug) : Promise.resolve(null),
);

export async function getArticleSlugs(): Promise<string[]> {
  return (await getArticles()).map((article) => article.slug).filter(isContentSlug);
}
