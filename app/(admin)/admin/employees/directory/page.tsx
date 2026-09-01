export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getLearningHistoryTargetsPage,
  parseLearningHistoryTargetQuery,
  type LearningHistoryTargetQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';
import { requireCapability } from '@/features/auth/server';

function directoryHref(
  query: LearningHistoryTargetQuery,
  cursor: { at: string; id: string } | null,
) {
  const params = new URLSearchParams();
  if (query.query) params.set('q', query.query);
  if (cursor) {
    params.set('cursorAt', cursor.at);
    params.set('cursorId', cursor.id);
  }
  const value = params.toString();
  return value ? `/admin/employees/directory?${value}` : '/admin/employees/directory';
}

export default async function EmployeeDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminSearchParams>;
}) {
  const actor = await requireCapability('results.delete');
  const query = parseLearningHistoryTargetQuery(await searchParams);
  const result = await getLearningHistoryTargetsPage(query);
  const backHref = actor.capabilities.includes('results.read') ? '/admin/employees' : '/admin';

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Все аккаунты сотрудников</h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
            Список строится по аккаунтам и профилям, поэтому здесь остаются сотрудники без
            аттестаций, с незавершёнными или неуспешными попытками.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={backHref}>
            {backHref === '/admin/employees' ? 'К рабочему списку' : 'К админ-панели'}
          </Link>
        </Button>
      </div>

      <form className="grid gap-3 rounded-xl border bg-[var(--color-surface)] p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="employee-directory-query">Имя или email</Label>
          <Input
            id="employee-directory-query"
            name="q"
            type="search"
            defaultValue={query.query}
            maxLength={100}
          />
        </div>
        <Button type="submit">Найти</Button>
        <Button asChild type="button" variant="outline">
          <Link href="/admin/employees/directory">Сбросить</Link>
        </Button>
      </form>

      {result.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={result.correlationId}
          message="Список аккаунтов временно не загрузился. Повторите запрос."
        />
      ) : result.data.items.length === 0 ? (
        <AdminEmptyState>Аккаунты по запросу не найдены.</AdminEmptyState>
      ) : (
        <>
          <ul className="grid gap-3">
            {result.data.items.map((user) => (
              <li
                key={user.id}
                className="flex flex-col gap-3 rounded-xl border bg-[var(--color-surface)] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-bold">{user.label}</p>
                  <p className="truncate text-sm text-[var(--color-text-muted)]">
                    {user.email ?? 'Вход по логину и паролю'}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-text-subtle)]">
                    Участник · {user.status === 'active' ? 'активен' : 'приостановлен'}
                  </p>
                </div>
                <Button asChild variant="outline">
                  <Link href={`/admin/employees/${user.id}/learning-history`} prefetch={false}>
                    Учебная история
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          <AdminPagination
            total={result.data.total}
            visible={result.data.items.length}
            hasCursor={Boolean(query.cursorAt && query.cursorId)}
            firstHref={directoryHref(query, null)}
            nextHref={
              result.data.hasMore && result.data.nextCursor
                ? directoryHref(query, result.data.nextCursor)
                : null
            }
          />
        </>
      )}
    </section>
  );
}
