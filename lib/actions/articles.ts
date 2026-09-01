'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { requireCapability } from '@/features/auth/server';
import {
  ARTICLES_CACHE_TAG,
  CONTENT_CACHE_TAG,
  CONTENT_REVALIDATE_PATHS,
} from '@/lib/content/cache-policy';
import { getArticleBySlug } from '@/lib/content/articles';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import {
  articleDraftInputSchema,
  articleDeleteInputSchema,
  articleStatusInputSchema,
  type ArticleLifecycleStatus,
} from '@/lib/validation/article';
import { defaultContentSeo } from '@/lib/validation/content-seo';

export type ArticleMutationResult = {
  id: string;
  slug: string;
  status: ArticleLifecycleStatus;
  publishedAt: string | null;
  draftVersion: number;
  contentHash: string;
  previousSlug?: string | null;
  publicationError?: 'ARTICLE_LOCALIZATIONS_INCOMPLETE' | 'ARTICLE_LOCALIZATION_PUBLISH_FAILED';
};

type ArticleRpcClient = {
  rpc(
    name:
      | 'save_article_draft_v2'
      | 'publish_article_revision_v3'
      | 'set_article_status_v2'
      | 'delete_article',
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

function parseMutationResult(value: unknown): ArticleMutationResult {
  if (!value || typeof value !== 'object') throw new Error('ARTICLE_MUTATION_RESULT_INVALID');
  const result = value as Record<string, unknown>;
  const status = result.status;
  if (
    typeof result.id !== 'string' ||
    typeof result.slug !== 'string' ||
    (status !== 'draft' && status !== 'published') ||
    (result.publishedAt !== null && typeof result.publishedAt !== 'string') ||
    typeof result.draftVersion !== 'number' ||
    typeof result.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(result.contentHash) ||
    (result.previousSlug !== undefined &&
      result.previousSlug !== null &&
      typeof result.previousSlug !== 'string')
  ) {
    throw new Error('ARTICLE_MUTATION_RESULT_INVALID');
  }
  return {
    id: result.id,
    slug: result.slug,
    status,
    publishedAt: result.publishedAt,
    draftVersion: result.draftVersion,
    contentHash: result.contentHash,
    ...(result.previousSlug !== undefined ? { previousSlug: result.previousSlug } : {}),
  };
}

function revalidateArticlePaths(slug: string, previousSlug?: string | null) {
  updateTag(CONTENT_CACHE_TAG);
  updateTag(ARTICLES_CACHE_TAG);
  for (const path of CONTENT_REVALIDATE_PATHS) revalidatePath(path);
  revalidatePath(`/blog/${slug}`);
  if (previousSlug && previousSlug !== slug) revalidatePath(`/blog/${previousSlug}`);
}

export async function saveArticleAction(input: unknown): Promise<ArticleMutationResult> {
  const article = articleDraftInputSchema.parse(input);
  await requireCapability('content.manage');
  const client = (await createClient()) as unknown as ArticleRpcClient;
  const response = await client.rpc('save_article_draft_v2', {
    p_article_id: article.id ?? null,
    p_original_slug: article.originalSlug ?? null,
    p_slug: article.slug,
    p_title: article.title,
    p_description: article.description,
    p_cover_image: article.coverImage,
    p_blocks: article.blocks,
    p_content_metadata: {
      jurisdiction: article.jurisdiction,
      effectiveDate: article.effectiveDate,
      sources: article.sources,
      draftVersion: article.draftVersion,
      seo: article.seo ?? defaultContentSeo(article.title, article.description, article.coverImage),
    },
  });
  const result = parseMutationResult(unwrapRpcMutationResponse(response));
  return result;
}

export async function publishArticleAction(input: unknown): Promise<ArticleMutationResult> {
  const article = articleDraftInputSchema.parse(input);
  const actor = await requireCapability('content.manage');
  const client = (await createClient()) as unknown as ArticleRpcClient;
  const savedResponse = await client.rpc('save_article_draft_v2', {
    p_article_id: article.id ?? null,
    p_original_slug: article.originalSlug ?? null,
    p_slug: article.slug,
    p_title: article.title,
    p_description: article.description,
    p_cover_image: article.coverImage,
    p_blocks: article.blocks,
    p_content_metadata: {
      jurisdiction: article.jurisdiction,
      effectiveDate: article.effectiveDate,
      sources: article.sources,
      draftVersion: article.draftVersion,
      seo: article.seo ?? defaultContentSeo(article.title, article.description, article.coverImage),
    },
  });
  const saved = parseMutationResult(unwrapRpcMutationResponse(savedResponse));
  let result: ArticleMutationResult;
  try {
    const response = await client.rpc('publish_article_revision_v3', {
      p_actor_id: actor.user.id,
      p_article_id: saved.id,
      p_expected_content_hash: saved.contentHash,
    });
    result = parseMutationResult(unwrapRpcMutationResponse(response));
  } catch (error) {
    if (error instanceof Error && error.message === 'ARTICLE_LOCALIZATIONS_INCOMPLETE') {
      return { ...saved, publicationError: 'ARTICLE_LOCALIZATIONS_INCOMPLETE' };
    }
    return { ...saved, publicationError: 'ARTICLE_LOCALIZATION_PUBLISH_FAILED' };
  }
  revalidateArticlePaths(result.slug, result.previousSlug);
  await getArticleBySlug(result.slug);
  return result;
}

export async function setArticleStatusAction(input: unknown): Promise<ArticleMutationResult> {
  const { articleId, status, expectedContentHash } = articleStatusInputSchema.parse(input);
  await requireCapability('content.manage');
  const client = (await createClient()) as unknown as ArticleRpcClient;
  const response = await client.rpc('set_article_status_v2', {
    p_article_id: articleId,
    p_status: status,
    p_expected_content_hash: expectedContentHash ?? null,
  });
  const result = parseMutationResult(unwrapRpcMutationResponse(response));
  revalidateArticlePaths(result.slug, result.previousSlug);
  if (result.status === 'published') await getArticleBySlug(result.slug);
  return result;
}

export async function deleteArticleAction(input: unknown) {
  const { articleId, expectedVersion } = articleDeleteInputSchema.parse(input);
  await requireCapability('content.manage');
  const client = (await createClient()) as unknown as ArticleRpcClient;
  const value = unwrapRpcMutationResponse(
    await client.rpc('delete_article', {
      p_article_id: articleId,
      p_expected_version: expectedVersion,
    }),
  );
  if (!value || typeof value !== 'object') throw new Error('ARTICLE_DELETE_RESULT_INVALID');
  const result = value as Record<string, unknown>;
  if (result.id !== articleId || typeof result.slug !== 'string' || result.deleted !== true) {
    throw new Error('ARTICLE_DELETE_RESULT_INVALID');
  }
  revalidateArticlePaths(result.slug);
  return { id: articleId, slug: result.slug };
}
