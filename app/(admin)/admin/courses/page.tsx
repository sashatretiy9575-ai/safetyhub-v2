export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { PencilSimple, Plus } from '@phosphor-icons/react/dist/ssr';
import { listTests } from '@/features/admin/server';
import { TestStatusControls } from '@/components/admin/test-status-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const STATUS_LABELS = { draft: 'Черновик', published: 'Опубликован' } as const;

export default async function AdminCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await searchParams;
  const query = (params.q ?? '').trim().toLocaleLowerCase('ru-RU').slice(0, 100);
  const status = ['draft', 'published'].includes(params.status ?? '')
    ? (params.status as 'draft' | 'published')
    : null;
  const allCourses = await listTests();
  const courses = allCourses.filter(
    (course) =>
      (course.status === 'draft' || course.status === 'published') &&
      (!query || course.title.toLocaleLowerCase('ru-RU').includes(query)) &&
      (!status || course.status === status),
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Курсы</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Презентации, варианты вопросов и публикация.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/courses/new">
            <Plus /> Новый курс
          </Link>
        </Button>
      </div>

      <form className="flex flex-col gap-2 rounded-xl border bg-[var(--color-surface)] p-3 sm:flex-row">
        <Input
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Название курса"
          aria-label="Поиск курсов"
          className="min-w-0 flex-1"
        />
        <select
          name="status"
          defaultValue={status ?? ''}
          aria-label="Статус курса"
          className="min-h-11 rounded-lg border bg-[var(--color-surface)] px-3 text-sm"
        >
          <option value="">Все статусы</option>
          <option value="draft">Черновики</option>
          <option value="published">Опубликованные</option>
        </select>
        <Button type="submit" size="sm">
          Найти
        </Button>
      </form>

      <div className="overflow-hidden rounded-xl border bg-[var(--color-surface)]">
        <div className="hidden min-h-10 grid-cols-[minmax(0,1.5fr)_12rem_auto] items-center gap-3 bg-[var(--color-surface-muted)] px-3 text-xs font-bold text-[var(--color-text-muted)] md:grid">
          <span>Курс</span>
          <span>Статус</span>
          <span className="sr-only">Действия</span>
        </div>
        {courses.map((course) => {
          const currentStatus = course.status === 'published' ? 'published' : 'draft';
          return (
            <article
              key={course.id}
              className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-t px-3 py-2 first:border-t-0 md:grid-cols-[minmax(0,1.5fr)_12rem_auto] md:gap-3"
            >
              <div className="min-w-0">
                <h2 className="truncate font-semibold" title={course.title}>
                  {course.title}
                </h2>
              </div>
              <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)] md:col-span-1">
                <Badge variant={currentStatus === 'published' ? 'success' : 'warning'}>
                  {STATUS_LABELS[currentStatus]}
                </Badge>
                {course.has_draft_changes ? <Badge variant="default">Есть черновик</Badge> : null}
              </div>
              <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 md:col-start-3">
                <Button
                  asChild
                  size="icon"
                  variant="ghost"
                  aria-label={`Редактировать: ${course.title}`}
                  title="Редактировать"
                >
                  <Link href={`/admin/courses/${course.id}`}>
                    <PencilSimple />
                  </Link>
                </Button>
                <TestStatusControls
                  testId={course.id}
                  status={currentStatus}
                  expectedVersion={course.draft_version}
                />
              </div>
            </article>
          );
        })}
        {courses.length === 0 ? (
          <p className="p-8 text-center text-[var(--color-text-muted)]">Курсы не найдены.</p>
        ) : null}
      </div>
    </section>
  );
}
