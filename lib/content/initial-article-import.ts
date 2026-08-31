import 'server-only';

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath, revalidateTag } from 'next/cache';
import { requireCapability } from '@/features/auth/server';
import {
  ARTICLES_CACHE_TAG,
  CONTENT_CACHE_TAG,
  CONTENT_REVALIDATE_PATHS,
} from '@/lib/content/cache-policy';
import { createAdminClient } from '@/lib/supabase/admin';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { createClient } from '@/lib/supabase/server';
import type { ArticleDraftRow, ArticleRow } from '@/lib/supabase/types';
import { articleDraftInputSchema, type ArticleDraftInput } from '@/lib/validation/article';

export const INITIAL_ARTICLE_IMPORT_PROJECT_REF = 'podkjjguhhdiecrgznoa';
export const INITIAL_ARTICLE_SNAPSHOT_HASH =
  'b7efc75f11555679d1682b26bc290c3f3b259559c427c208e0104799945c38e7';
export const INITIAL_ARTICLE_SNAPSHOT_COUNT = 10;
export const INITIAL_ARTICLE_IMPORT_CONFIRMATION = `INITIAL-ARTICLES-IMPORT:${INITIAL_ARTICLE_IMPORT_PROJECT_REF}:${INITIAL_ARTICLE_SNAPSHOT_HASH}`;

type ImportStatus = 'publish' | 'skip';
type Inventory = {
  articles: ArticleRow[];
  drafts: ArticleDraftRow[];
  redirects: Array<{ old_slug: string; article_id: string; created_at: string }>;
};

type ArticleRpcClient = {
  rpc(
    name: 'save_and_publish_article_v2',
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
};

export type InitialArticleImportReceipt = Readonly<{
  projectRef: string;
  snapshotHash: string;
  expected: number;
  published: number;
  skipped: number;
  verified: number;
}>;

export class InitialArticleImportError extends Error {
  constructor(
    public readonly code:
      | 'INITIAL_ARTICLE_CONFIRMATION_MISMATCH'
      | 'INITIAL_ARTICLE_HOSTED_CONFLICT'
      | 'INITIAL_ARTICLE_PROJECT_MISMATCH'
      | 'INITIAL_ARTICLE_SNAPSHOT_INVALID'
      | 'INITIAL_ARTICLE_VERIFICATION_FAILED',
    public readonly status: 400 | 409 | 503,
  ) {
    super(code);
    this.name = 'InitialArticleImportError';
  }
}

function fail(
  code: InitialArticleImportError['code'],
  status: InitialArticleImportError['status'],
): never {
  throw new InitialArticleImportError(code, status);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function canonicalHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function snapshotArticle(value: unknown, filename: string): ArticleDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INITIAL_ARTICLE_SNAPSHOT_INVALID', 503);
  }
  const article = value as Record<string, unknown>;
  const parsed = articleDraftInputSchema.safeParse({
    slug: article.slug,
    title: article.title,
    description: article.description,
    coverImage: article.coverImage,
    blocks: article.blocks,
    seo: article.seo,
    jurisdiction: article.jurisdiction,
    effectiveDate: article.effectiveDate,
    sources: article.sources,
  });
  if (!parsed.success || filename !== `${parsed.data.slug}.json`) {
    fail('INITIAL_ARTICLE_SNAPSHOT_INVALID', 503);
  }
  return parsed.data;
}

async function loadApprovedSnapshot() {
  const directory = path.join(process.cwd(), 'content', 'articles');
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith('.json'))
    .sort();
  const rawArticles = await Promise.all(
    filenames.map(
      async (filename) =>
        JSON.parse(await readFile(path.join(directory, filename), 'utf8')) as unknown,
    ),
  );
  if (
    filenames.length !== INITIAL_ARTICLE_SNAPSHOT_COUNT ||
    canonicalHash(rawArticles) !== INITIAL_ARTICLE_SNAPSHOT_HASH
  ) {
    fail('INITIAL_ARTICLE_SNAPSHOT_INVALID', 503);
  }
  const articles = rawArticles.map((article, index) =>
    snapshotArticle(article, filenames[index] ?? ''),
  );
  if (new Set(articles.map((article) => article.slug)).size !== articles.length) {
    fail('INITIAL_ARTICLE_SNAPSHOT_INVALID', 503);
  }
  return articles;
}

function configuredProjectRef() {
  const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredUrl) fail('INITIAL_ARTICLE_PROJECT_MISMATCH', 409);
  try {
    const url = new URL(configuredUrl);
    const match = url.hostname.match(/^([a-z0-9]{20})[.]supabase[.]co$/u);
    if (url.protocol !== 'https:' || !match) {
      fail('INITIAL_ARTICLE_PROJECT_MISMATCH', 409);
    }
    return match[1]!;
  } catch (error) {
    if (error instanceof InitialArticleImportError) throw error;
    fail('INITIAL_ARTICLE_PROJECT_MISMATCH', 409);
  }
}

async function loadInventory(): Promise<Inventory> {
  const admin = createAdminClient();
  const [articles, drafts, redirects] = await Promise.all([
    admin.from('articles').select('*').limit(100),
    admin.from('article_drafts').select('*').limit(100),
    admin.from('article_slug_redirects').select('*').limit(100),
  ]);
  if (articles.error || drafts.error || redirects.error) {
    throw articles.error ?? drafts.error ?? redirects.error;
  }
  return {
    articles: articles.data ?? [],
    drafts: drafts.data ?? [],
    redirects: redirects.data ?? [],
  };
}

function draftPayload(row: ArticleDraftRow): ArticleDraftInput {
  return articleDraftInputSchema.parse({
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverImage: row.cover_image,
    blocks: row.blocks,
    seo: row.seo,
    jurisdiction: row.jurisdiction ?? '',
    effectiveDate: row.effective_date ?? '',
    sources: row.sources,
  });
}

function publishedPayload(row: ArticleRow): ArticleDraftInput {
  return articleDraftInputSchema.parse({
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverImage: row.cover_image,
    blocks: row.blocks,
    seo: row.seo,
    jurisdiction: row.jurisdiction ?? '',
    effectiveDate: row.effective_date ?? '',
    sources: row.sources,
  });
}

function isSameArticle(left: ArticleDraftInput, right: ArticleDraftInput) {
  return canonicalJson(left) === canonicalJson(right);
}

function importStatuses(snapshot: ArticleDraftInput[], inventory: Inventory) {
  const expectedSlugs = new Set(snapshot.map((article) => article.slug));
  if (
    inventory.redirects.length > 0 ||
    inventory.articles.length > snapshot.length ||
    inventory.drafts.length > snapshot.length ||
    inventory.articles.some((article) => !expectedSlugs.has(article.slug)) ||
    inventory.drafts.some((draft) => !expectedSlugs.has(draft.slug))
  ) {
    fail('INITIAL_ARTICLE_HOSTED_CONFLICT', 409);
  }

  const articlesById = new Map(inventory.articles.map((article) => [article.id, article]));
  const draftsBySlug = new Map(inventory.drafts.map((draft) => [draft.slug, draft]));
  const statuses = new Map<string, ImportStatus>();

  for (const expected of snapshot) {
    const draft = draftsBySlug.get(expected.slug);
    const article = draft ? articlesById.get(draft.article_id) : undefined;
    if (!draft && !inventory.articles.some((row) => row.slug === expected.slug)) {
      statuses.set(expected.slug, 'publish');
      continue;
    }
    if (
      !draft ||
      !article ||
      article.slug !== expected.slug ||
      !isSameArticle(expected, draftPayload(draft))
    ) {
      fail('INITIAL_ARTICLE_HOSTED_CONFLICT', 409);
    }

    if (article.status === 'published') {
      if (
        !article.is_published ||
        !article.current_revision_id ||
        !article.published_at ||
        article.content_version < 1 ||
        article.content_hash !== draft.content_hash ||
        !isSameArticle(expected, publishedPayload(article))
      ) {
        fail('INITIAL_ARTICLE_HOSTED_CONFLICT', 409);
      }
      statuses.set(expected.slug, 'skip');
      continue;
    }

    if (
      article.status !== 'draft' ||
      article.is_published ||
      article.current_revision_id ||
      article.published_at ||
      article.content_version !== 0
    ) {
      fail('INITIAL_ARTICLE_HOSTED_CONFLICT', 409);
    }
    statuses.set(expected.slug, 'publish');
  }

  if (statuses.size !== snapshot.length) {
    fail('INITIAL_ARTICLE_HOSTED_CONFLICT', 409);
  }
  return statuses;
}

function assertVerified(snapshot: ArticleDraftInput[], inventory: Inventory) {
  if (
    inventory.redirects.length > 0 ||
    inventory.articles.length !== snapshot.length ||
    inventory.drafts.length !== snapshot.length
  ) {
    fail('INITIAL_ARTICLE_VERIFICATION_FAILED', 409);
  }
  const articlesById = new Map(inventory.articles.map((article) => [article.id, article]));
  const draftsBySlug = new Map(inventory.drafts.map((draft) => [draft.slug, draft]));
  for (const expected of snapshot) {
    const draft = draftsBySlug.get(expected.slug);
    const article = draft ? articlesById.get(draft.article_id) : undefined;
    if (
      !draft ||
      !article ||
      article.slug !== expected.slug ||
      article.status !== 'published' ||
      !article.is_published ||
      !article.current_revision_id ||
      !article.published_at ||
      article.content_version < 1 ||
      article.content_hash !== draft.content_hash ||
      !isSameArticle(expected, draftPayload(draft)) ||
      !isSameArticle(expected, publishedPayload(article))
    ) {
      fail('INITIAL_ARTICLE_VERIFICATION_FAILED', 409);
    }
  }
}

function invalidateArticleContent(snapshot: ArticleDraftInput[]) {
  revalidateTag(CONTENT_CACHE_TAG, { expire: 0 });
  revalidateTag(ARTICLES_CACHE_TAG, { expire: 0 });
  for (const route of CONTENT_REVALIDATE_PATHS) revalidatePath(route);
  for (const article of snapshot) revalidatePath(`/blog/${article.slug}`);
}

export async function importApprovedInitialArticles(
  confirmation: string,
): Promise<InitialArticleImportReceipt> {
  await requireCapability('content.manage');
  if (configuredProjectRef() !== INITIAL_ARTICLE_IMPORT_PROJECT_REF) {
    fail('INITIAL_ARTICLE_PROJECT_MISMATCH', 409);
  }
  if (confirmation !== INITIAL_ARTICLE_IMPORT_CONFIRMATION) {
    fail('INITIAL_ARTICLE_CONFIRMATION_MISMATCH', 400);
  }

  const snapshot = await loadApprovedSnapshot();
  const before = await loadInventory();
  const statuses = importStatuses(snapshot, before);
  const draftsBySlug = new Map(before.drafts.map((draft) => [draft.slug, draft]));
  const client = (await createClient()) as unknown as ArticleRpcClient;
  let published = 0;
  let skipped = 0;

  for (const article of snapshot) {
    if (statuses.get(article.slug) === 'skip') {
      skipped += 1;
      continue;
    }
    const existing = draftsBySlug.get(article.slug);
    const result = unwrapRpcMutationResponse(
      await client.rpc('save_and_publish_article_v2', {
        p_article_id: existing?.article_id ?? null,
        p_original_slug: existing?.slug ?? null,
        p_slug: article.slug,
        p_title: article.title,
        p_description: article.description,
        p_cover_image: article.coverImage,
        p_blocks: article.blocks,
        p_content_metadata: {
          jurisdiction: article.jurisdiction,
          effectiveDate: article.effectiveDate,
          sources: article.sources,
          draftVersion: existing?.draft_version,
          seo: article.seo,
        },
      }),
    );
    if (
      !result ||
      typeof result !== 'object' ||
      (result as Record<string, unknown>).slug !== article.slug ||
      (result as Record<string, unknown>).status !== 'published'
    ) {
      fail('INITIAL_ARTICLE_VERIFICATION_FAILED', 409);
    }
    published += 1;
  }

  const after = await loadInventory();
  assertVerified(snapshot, after);
  invalidateArticleContent(snapshot);
  return {
    projectRef: INITIAL_ARTICLE_IMPORT_PROJECT_REF,
    snapshotHash: INITIAL_ARTICLE_SNAPSHOT_HASH,
    expected: snapshot.length,
    published,
    skipped,
    verified: after.articles.length,
  };
}
