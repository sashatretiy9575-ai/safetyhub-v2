export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Plus } from '@phosphor-icons/react/dist/ssr';
import * as z from 'zod';
import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';
import type { ArticleLifecycleStatus } from '@/lib/validation/article';
import {
  AdminListEmpty,
  AdminListHeader,
  AdminListRow,
  AdminListSheet,
} from '@/components/admin/admin-list';
import { AdminSearchPanel } from '@/components/admin/admin-search-panel';
import { RowDeleteAction } from '@/components/admin/row-delete-action';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { readListFilters } from '@/lib/admin/list-return';

const BASE_PATH = '/admin/articles';

type AdminClient = ReturnType<typeof createAdminClient>;

type ArticleListRpcClient = {
  rpc(
    name: 'list_admin_article_drafts',
    args: { p_query: string | null; p_limit: number },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

const articleListSchema = z.array(
  z.object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(['draft', 'published']),
    isPublished: z.boolean(),
    updatedAt: z.string(),
    hasDraftChanges: z.boolean(),
  }),
);

const statusLabel: Record<ArticleLifecycleStatus, string> = {
  draft: 'Черновик',
  published: 'Опубликовано',
};

const DRAFT_VERSION_CHUNK = 100;

/**
 * `list_admin_article_drafts` leaves the draft version out, and `delete_article`
 * checks a deletion against it. One narrow read fetches the versions of the
 * rows on screen; a row that comes back without one keeps its bin disabled.
 */
async function readDraftVersions(admin: AdminClient, articleIds: string[]) {
  const chunks: string[][] = [];
  for (let start = 0; start < articleIds.length; start += DRAFT_VERSION_CHUNK) {
    chunks.push(articleIds.slice(start, start + DRAFT_VERSION_CHUNK));
  }
  const versions = new Map<string, number>();
  const results = await Promise.all(
    chunks.map((ids) =>
      admin.from('article_drafts').select('article_id,draft_version').in('article_id', ids),
    ),
  );
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of data ?? []) versions.set(row.article_id, row.draft_version);
  }
  return versions;
}

export default async function AdminArticlesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability('content.manage');
  const filters = readListFilters(await searchParams);
  const admin = createAdminClient();
  const { data, error } = await (admin as unknown as ArticleListRpcClient).rpc(
    'list_admin_article_drafts',
    { p_query: filters.q || null, p_limit: 200 },
  );
  if (error) throw error;
  const articles = articleListSchema
    .parse(data)
    .filter((article) => !filters.status || article.status === filters.status);
  const draftVersions = await readDraftVersions(
    admin,
    articles.map((article) => article.id),
  );

  return (
    <section className="space-y-4">
      <AdminListHeader
        count={articles.length}
        resetHref={filters.q || filters.status ? BASE_PATH : null}
        action={
          <Button asChild size="sm">
            <Link href={`${BASE_PATH}/new`}>
              <Plus /> Новая статья
            </Link>
          </Button>
        }
      >
        <h1 className="font-display text-h3 font-bold">Материалы</h1>
      </AdminListHeader>

      <AdminSearchPanel
        basePath={BASE_PATH}
        q={filters.q}
        status={filters.status}
        searchLabel="Поиск материалов"
        statusLabel="Статус материала"
      />

      <AdminListSheet nameLabel="Название">
        {articles.map((article) => (
          <AdminListRow
            key={article.id}
            title={article.title}
            href={`${BASE_PATH}/${article.slug}/edit`}
            slug={article.slug}
            updatedAt={article.updatedAt}
            badges={
              <>
                <Badge variant={article.status === 'published' ? 'success' : 'warning'}>
                  {statusLabel[article.status]}
                </Badge>
                {article.hasDraftChanges ? <Badge variant="default">Есть черновик</Badge> : null}
              </>
            }
            actions={
              <RowDeleteAction
                kind="article"
                id={article.id}
                title={article.title}
                expectedVersion={draftVersions.get(article.id) ?? null}
              />
            }
          />
        ))}
        {articles.length === 0 ? <AdminListEmpty /> : null}
      </AdminListSheet>
    </section>
  );
}
