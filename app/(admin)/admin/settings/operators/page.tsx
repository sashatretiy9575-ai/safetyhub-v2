export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { OperatorRoleForm } from '@/components/admin/operator-role-form';
import { OperatorRevokeButton } from '@/components/admin/operator-revoke-button';
import { PendingGrantRevokeButton } from '@/components/admin/pending-grant-revoke-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ADMIN_PAGE_SIZE,
  getAdminOperatorsPage,
  getPendingAdminGrants,
  parseAdminOperatorQuery,
  type AdminOperatorQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';
import {
  ADMIN_TRAIL_PARAM,
  appendAdminTrail,
  parseAdminTrail,
  serializeAdminTrail,
} from '@/lib/admin/pagination-trail';
import { requireCapability } from '@/features/auth/server';

function operatorsHref(
  query: AdminOperatorQuery,
  cursorToken: string,
  trail: readonly string[],
) {
  const params = new URLSearchParams();
  if (query.query) params.set('q', query.query);
  if (cursorToken) {
    const [at = '', id = ''] = cursorToken.split('|');
    params.set('cursorAt', at);
    params.set('cursorId', id);
  }
  const serialized = serializeAdminTrail(trail);
  if (serialized) params.set(ADMIN_TRAIL_PARAM, serialized);
  const value = params.toString();
  return value ? `/admin/settings/operators?${value}` : '/admin/settings/operators';
}

export default async function AdminOperatorsPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminSearchParams>;
}) {
  await requireCapability('role.manage');
  const params = await searchParams;
  const query = parseAdminOperatorQuery(params);
  const [result, pendingGrants] = await Promise.all([
    getAdminOperatorsPage(query),
    getPendingAdminGrants(),
  ]);
  const trail = parseAdminTrail(params[ADMIN_TRAIL_PARAM]);
  const currentToken = query.cursorAt && query.cursorId ? `${query.cursorAt}|${query.cursorId}` : '';
  const previousToken = trail.length > 0 ? (trail[trail.length - 1] ?? '') : null;

  return (
    <section className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">Администраторы</h1>
        <Button asChild variant="outline">
          <Link href="/admin/settings">К настройкам</Link>
        </Button>
      </div>

      <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="text-lg font-bold">Добавить администратора</h2>
        <OperatorRoleForm />
      </section>

      {pendingGrants.state === 'ready' && pendingGrants.data.items.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="text-lg font-bold">Ждут первого входа</h2>
          <ul className="grid gap-2">
            {pendingGrants.data.items.map((grant) => (
              <li
                key={grant.email}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-bold">{grant.email}</p>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">{grant.reason}</p>
                </div>
                <PendingGrantRevokeButton email={grant.email} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form className="grid gap-3 rounded-xl border bg-[var(--color-surface)] p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="operators-query">Имя или почта</Label>
          <Input
            id="operators-query"
            name="q"
            type="search"
            defaultValue={query.query}
            maxLength={100}
          />
        </div>
        <Button type="submit">Найти</Button>
        <Button asChild type="button" variant="outline">
          <Link href="/admin/settings/operators">Сбросить</Link>
        </Button>
      </form>

      {result.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={result.correlationId}
          message="Список администраторов временно не загрузился. Повторите запрос."
        />
      ) : result.data.items.length === 0 ? (
        <AdminEmptyState>Администраторы по запросу не найдены.</AdminEmptyState>
      ) : (
        <>
          <ul className="grid gap-3">
            {result.data.items.map((operator) => (
              <li
                key={operator.id}
                className="flex flex-col gap-3 rounded-xl border bg-[var(--color-surface)] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-bold">
                    {operator.label}
                    {operator.isSelf ? ' · это вы' : ''}
                  </p>
                  <p className="truncate text-sm text-[var(--color-text-muted)]">
                    {operator.email ?? 'Вход по логину и паролю'}
                  </p>
                </div>
                {operator.isSelf || operator.protected ? (
                  <p className="shrink-0 text-xs text-[var(--color-text-subtle)]">
                    {operator.isSelf ? 'Свой доступ снять нельзя' : 'Основной доступ'}
                  </p>
                ) : (
                  <OperatorRevokeButton userId={operator.id} label={operator.label} />
                )}
              </li>
            ))}
          </ul>
          <AdminPagination
            total={result.data.total}
            visible={result.data.items.length}
            pageIndex={trail.length}
            pageSize={ADMIN_PAGE_SIZE}
            firstHref={operatorsHref(query, '', [])}
            previousHref={
              previousToken === null
                ? null
                : operatorsHref(query, previousToken, trail.slice(0, -1))
            }
            nextHref={
              result.data.hasMore && result.data.nextCursor
                ? operatorsHref(
                    query,
                    `${result.data.nextCursor.at}|${result.data.nextCursor.id}`,
                    appendAdminTrail(trail, currentToken),
                  )
                : null
            }
          />
        </>
      )}
    </section>
  );
}
