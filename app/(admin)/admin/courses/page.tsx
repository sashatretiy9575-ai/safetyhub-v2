export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Plus } from '@phosphor-icons/react/dist/ssr';
import { listTests } from '@/server/admin/management';
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

const BASE_PATH = '/admin/courses';
const STATUS_LABELS = { draft: 'Черновик', published: 'Опубликован' } as const;

export default async function AdminCoursesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = readListFilters(await searchParams);
  const needle = filters.q.toLocaleLowerCase('ru-RU');
  const courses = (await listTests()).filter(
    (course) =>
      (course.status === 'draft' || course.status === 'published') &&
      (!needle || course.title.toLocaleLowerCase('ru-RU').includes(needle)) &&
      (!filters.status || course.status === filters.status),
  );

  return (
    <section className="space-y-4">
      <AdminListHeader
        count={courses.length}
        resetHref={filters.q || filters.status ? BASE_PATH : null}
        action={
          <Button asChild size="sm">
            <Link href={`${BASE_PATH}/new`}>
              <Plus /> Новый курс
            </Link>
          </Button>
        }
      >
        <h1 className="font-display text-h3 font-bold">Курсы</h1>
      </AdminListHeader>

      <AdminSearchPanel
        basePath={BASE_PATH}
        q={filters.q}
        status={filters.status}
        searchLabel="Поиск курсов"
        statusLabel="Статус курса"
      />

      <AdminListSheet nameLabel="Курс">
        {courses.map((course) => {
          const status = course.status === 'published' ? 'published' : 'draft';
          return (
            <AdminListRow
              key={course.id}
              title={course.title}
              href={`${BASE_PATH}/${course.id}`}
              slug={course.slug}
              updatedAt={course.updated_at}
              badges={
                <>
                  <Badge variant={status === 'published' ? 'success' : 'warning'}>
                    {STATUS_LABELS[status]}
                  </Badge>
                  {course.has_draft_changes ? <Badge variant="default">Есть черновик</Badge> : null}
                </>
              }
              actions={
                <RowDeleteAction
                  kind="course"
                  id={course.id}
                  title={course.title}
                  expectedVersion={course.draft_version}
                />
              }
            />
          );
        })}
        {courses.length === 0 ? <AdminListEmpty /> : null}
      </AdminListSheet>
    </section>
  );
}
