export const dynamic = 'force-dynamic';

import Link from 'next/link';
import {
  Article,
  ArrowSquareOut,
  MagnifyingGlass,
  PencilSimple,
  Plus,
} from '@phosphor-icons/react/dist/ssr';
import * as z from 'zod';
import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';
import type { ArticleLifecycleStatus } from '@/lib/validation/article';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AdminFilterSelect } from '@/components/admin/admin-filter-select';

type SearchParams = { q?: string; status?: string };

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
type ArticleRow = {
  id: string;
  slug: string;
  title: string;
  status: ArticleLifecycleStatus;
  is_published: boolean;
  updated_at: string;
  hasDraftChanges: boolean;
};

const statusLabel: Record<ArticleLifecycleStatus, string> = {
  draft: 'Черновик',
  published: 'Опубликовано',
};

export default async function AdminArticlesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireCapability('content.manage');
  const params = await searchParams;
  const query = (params.q ?? '').trim().slice(0, 100);
  const selectedStatus = ['draft', 'published'].includes(params.status ?? '')
    ? params.status!
    : 'all';
  const admin = createAdminClient() as unknown as ArticleListRpcClient;
  const { data, error } = await admin.rpc('list_admin_article_drafts', {
    p_query: query || null,
    p_limit: 200,
  });
  if (error) throw error;
  let articles = articleListSchema.parse(data).map(
    (row) =>
      ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        is_published: row.isPublished,
        updated_at: row.updatedAt,
        hasDraftChanges: row.hasDraftChanges,
      }) satisfies ArticleRow,
  );
  if (selectedStatus !== 'all') {
    articles = articles.filter((article) => article.status === selectedStatus);
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-display text-h3 font-bold">Материалы</h1>
          <span className="rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-text-muted)] tabular-nums">
            {articles.length}
          </span>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/articles/new">
            <Plus /> Новая статья
          </Link>
        </Button>
      </div>

      <form className="flex gap-2 rounded-xl border bg-[var(--color-surface)] p-2.5 sm:p-3">
        <Input
          name="q"
          defaultValue={query}
          placeholder="Название статьи"
          aria-label="Поиск по названию статьи"
          className="min-w-0 flex-1"
        />
        <AdminFilterSelect
          name="status"
          defaultValue={selectedStatus === 'all' ? '' : selectedStatus}
          aria-label="Статус материала"
        >
          <option value="">Все</option>
          <option value="draft">Черновики</option>
          <option value="published">Опубликованные</option>
        </AdminFilterSelect>
        <Button type="submit" size="sm" className="min-h-11 shrink-0" aria-label="Найти">
          <MagnifyingGlass aria-hidden size={18} className="xs:hidden" />
          <span className="xs:inline hidden">Найти</span>
        </Button>
      </form>

      {articles.length ? (
        <div className="overflow-hidden rounded-[var(--radius-group)] border bg-[var(--color-surface)]">
          <div className="hidden min-h-11 grid-cols-[minmax(0,2fr)_11rem_8rem_auto] items-center gap-3 bg-[var(--color-surface-muted)] px-4 text-xs font-bold text-[var(--color-text-muted)] md:grid">
            <span>Название</span>
            <span>Статус</span>
            <span>Изменено</span>
            <span className="text-right">Действия</span>
          </div>
          {articles.map((item) => {
            const editHref = `/admin/articles/${item.slug}/edit`;
            const updated = new Date(item.updated_at);
            return (
              <article
                key={item.id}
                // Phone: title and actions on one line, status and date on the
                // next; the desktop sheet keeps its columns.
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 border-t px-3 py-2.5 first:border-t-0 md:min-h-16 md:grid-cols-[minmax(0,2fr)_11rem_8rem_auto] md:gap-3 md:px-4"
              >
                <div className="min-w-0">
                  {/* The title is the primary way into the editor: an icon-only
                      "…" button was the only affordance before, and its glyph
                      read as "more", not "edit". */}
                  <h2 className="font-semibold break-words">
                    <Link
                      href={editHref}
                      className="hover:text-[var(--color-primary)] hover:underline"
                    >
                      {item.title}
                    </Link>
                  </h2>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">/{item.slug}</p>
                </div>
                <div className="col-span-2 flex flex-wrap items-center gap-1.5 md:col-span-1">
                  <Badge variant={item.status === 'published' ? 'success' : 'warning'}>
                    {statusLabel[item.status]}
                  </Badge>
                  {item.hasDraftChanges ? <Badge variant="default">Есть черновик</Badge> : null}
                  <span className="text-xs text-[var(--color-text-muted)] tabular-nums md:hidden">
                    <time dateTime={item.updated_at}>{updated.toLocaleDateString('ru-RU')}</time>
                  </span>
                </div>
                <div className="hidden text-xs text-[var(--color-text-muted)] tabular-nums md:block">
                  <time dateTime={item.updated_at}>
                    {updated.toLocaleDateString('ru-RU')}
                    <span className="ml-1.5 text-[var(--color-text-subtle)]">
                      {updated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </time>
                </div>
                <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 md:col-start-4">
                  {item.status === 'published' ? (
                    <Button
                      asChild
                      size="sm"
                      variant="ghost"
                      className="h-9 px-2 text-xs"
                      title="Открыть на сайте"
                    >
                      <Link
                        href={`/blog/${item.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Открыть на сайте: ${item.title}`}
                      >
                        <ArrowSquareOut aria-hidden />
                      </Link>
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="outline" className="h-9 px-2.5 text-xs">
                    <Link href={editHref} aria-label={`Редактировать: ${item.title}`}>
                      <PencilSimple aria-hidden />
                      <span className="xs:inline hidden">Изменить</span>
                    </Link>
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-sm text-[var(--color-text-muted)]">
            <Article className="mx-auto mb-3" size={36} />
            Материалы не найдены.
          </CardContent>
        </Card>
      )}
    </section>
  );
}
