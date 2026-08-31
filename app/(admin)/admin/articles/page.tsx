export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Article, DotsThree, Plus } from '@phosphor-icons/react/dist/ssr';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ArticleLifecycleStatus } from '@/lib/validation/article';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type SearchParams = { q?: string; status?: string };
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
  const admin = createAdminClient();
  let request = admin.from('article_drafts').select('*').order('updated_at', { ascending: false });
  if (query) request = request.ilike('title', `%${query.replace(/[%_]/g, '\\$&')}%`);
  const { data: drafts, error } = await request.limit(200);
  if (error) throw error;
  const articleIds = (drafts ?? []).map((draft) => draft.article_id);
  const live = articleIds.length
    ? await admin.from('articles').select('*').in('id', articleIds)
    : { data: [], error: null };
  if (live.error) throw live.error;
  const liveById = new Map((live.data ?? []).map((article) => [article.id, article]));
  let articles = (drafts ?? []).flatMap((draft) => {
    const article = liveById.get(draft.article_id);
    if (!article) return [];
    if (article.status !== 'draft' && article.status !== 'published') return [];
    return [
      {
        id: article.id,
        slug: draft.slug,
        title: draft.title,
        status: article.status,
        is_published: article.is_published,
        updated_at: draft.updated_at,
        hasDraftChanges:
          article.status === 'published' && article.content_hash !== draft.content_hash,
      } satisfies ArticleRow,
    ];
  });
  if (selectedStatus !== 'all') {
    articles = articles.filter((article) => article.status === selectedStatus);
  }

  const tabs = [
    ['all', 'Все'],
    ['draft', 'Черновики'],
    ['published', 'Опубликованные'],
  ] as const;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Материалы</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Черновики и опубликованные статьи в одном списке.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/articles/new">
            <Plus /> Новая статья
          </Link>
        </Button>
      </div>

      <form className="flex flex-col gap-2 rounded-xl border bg-[var(--color-surface)] p-3 sm:flex-row">
        <Input
          name="q"
          defaultValue={query}
          placeholder="Название статьи"
          aria-label="Поиск по названию статьи"
          className="min-w-0 flex-1"
        />
        {selectedStatus !== 'all' ? (
          <input type="hidden" name="status" value={selectedStatus} />
        ) : null}
        <Button type="submit" size="sm">
          Найти
        </Button>
      </form>

      <nav aria-label="Статусы материалов" className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map(([value, label]) => {
          const search = new URLSearchParams();
          if (query) search.set('q', query);
          if (value !== 'all') search.set('status', value);
          return (
            <Link
              key={value}
              href={`/admin/articles${search.size ? `?${search}` : ''}`}
              aria-current={selectedStatus === value ? 'page' : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-semibold ${
                selectedStatus === value
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]'
                  : 'bg-[var(--color-surface)]'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {articles.length ? (
        <div className="overflow-hidden rounded-2xl border bg-[var(--color-surface)]">
          <div className="hidden min-h-11 grid-cols-[minmax(0,2fr)_9rem_11rem_3rem] items-center gap-3 bg-[var(--color-surface-muted)] px-4 text-xs font-bold text-[var(--color-text-muted)] min-[760px]:grid">
            <span>Название</span>
            <span>Статус</span>
            <span>Изменено</span>
            <span className="sr-only">Действие</span>
          </div>
          {articles.map((item) => {
            return (
              <article
                key={item.id}
                className="grid gap-3 border-t p-4 first:border-t-0 min-[760px]:min-h-[68px] min-[760px]:grid-cols-[minmax(0,2fr)_9rem_11rem_3rem] min-[760px]:items-center"
              >
                <div className="min-w-0">
                  <h2 className="font-semibold break-words">{item.title}</h2>
                  <p className="text-xs text-[var(--color-text-muted)]">/{item.slug}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={item.status === 'published' ? 'success' : 'warning'}>
                    {statusLabel[item.status]}
                  </Badge>
                  {item.hasDraftChanges ? <Badge variant="default">Есть черновик</Badge> : null}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  <p>{new Date(item.updated_at).toLocaleDateString('ru-RU')}</p>
                </div>
                <Button
                  asChild
                  size="icon"
                  variant="ghost"
                  aria-label={`Редактировать: ${item.title}`}
                >
                  <Link href={`/admin/articles/${item.slug}/edit`}>
                    <DotsThree />
                  </Link>
                </Button>
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
