import { notFound } from 'next/navigation';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { AdminEditor } from '@/components/admin/admin-editor';
import type { Article } from '@/lib/content/articles';
import { coerceContentMetadata } from '@/lib/content/content-metadata';
import { articleBlocksSchema, type ArticleLifecycleStatus } from '@/lib/validation/article';
import { contentSeoSchema, defaultContentSeo } from '@/lib/validation/content-seo';
import { getArticleEditorLocalizations } from '@/features/admin/localizations-server';

export default async function EditArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ publication?: string }>;
}) {
  await requireCapability('content.manage');
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('article_drafts')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) notFound();
  const blocks = articleBlocksSchema.safeParse(data.blocks);
  if (!blocks.success) throw new Error('ARTICLE_BLOCKS_INVALID');
  const live = await admin
    .from('articles')
    .select('status,is_published,published_at,current_revision_id,content_hash')
    .eq('id', data.article_id)
    .maybeSingle();
  if (live.error) throw live.error;
  if (!live.data) notFound();
  const lifecycleStatus: ArticleLifecycleStatus = live.data.status;
  const publicationState = !live.data.current_revision_id
    ? 'never_published'
    : lifecycleStatus === 'draft'
      ? 'draft'
      : live.data.content_hash === data.content_hash
        ? 'published'
        : 'published_with_draft_changes';
  const article: Article = {
    id: data.article_id,
    originalSlug: data.slug,
    slug: data.slug,
    title: data.title,
    description: data.description,
    coverImage: data.cover_image,
    createdAt: data.created_at.slice(0, 10),
    publishedAt: live.data.published_at,
    status: lifecycleStatus,
    publicationState,
    publishedContentHash: live.data.current_revision_id ? live.data.content_hash : null,
    draftVersion: data.draft_version,
    contentHash: data.content_hash,
    seo: contentSeoSchema.safeParse(data.seo).success
      ? contentSeoSchema.parse(data.seo)
      : defaultContentSeo(data.title, data.description, data.cover_image),
    ...coerceContentMetadata({
      jurisdiction: data.jurisdiction ?? '',
      effectiveDate: data.effective_date ?? '',
      sources: data.sources,
    }),
    blocks: blocks.data,
  };
  const localizations = await getArticleEditorLocalizations(data.article_id);
  return (
    <AdminEditor
      initialData={article}
      initialLocalizations={localizations}
      initialPublicationNotice={
        query.publication === 'incomplete' || query.publication === 'failed'
          ? query.publication
          : null
      }
    />
  );
}
