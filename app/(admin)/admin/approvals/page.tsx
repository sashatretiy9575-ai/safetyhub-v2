export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { AccountApprovalQueue } from '@/components/admin/account-approval-queue';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { Button } from '@/components/ui/button';
import {
  ADMIN_PAGE_SIZE,
  getPendingAccountApprovalPage,
  parseAdminAccountApprovalQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';
import {
  ADMIN_TRAIL_PARAM,
  appendAdminTrail,
  parseAdminTrail,
  serializeAdminTrail,
} from '@/lib/admin/pagination-trail';

function approvalHref(cursorToken: string, trail: readonly string[]) {
  const params = new URLSearchParams();
  if (cursorToken) {
    const [at = '', id = ''] = cursorToken.split('|');
    params.set('cursorAt', at);
    params.set('cursorId', id);
  }
  const serialized = serializeAdminTrail(trail);
  if (serialized) params.set(ADMIN_TRAIL_PARAM, serialized);
  const search = params.toString();
  return search ? `/admin/approvals?${search}` : '/admin/approvals';
}

export default async function AdminApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminSearchParams>;
}) {
  const params = await searchParams;
  const query = parseAdminAccountApprovalQuery(params);
  const result = await getPendingAccountApprovalPage(query);
  const trail = parseAdminTrail(params[ADMIN_TRAIL_PARAM]);
  const currentToken = query.cursorAt && query.cursorId ? `${query.cursorAt}|${query.cursorId}` : '';
  const previousToken = trail.length > 0 ? (trail[trail.length - 1] ?? '') : null;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-2xl font-bold">Заявки на обучение</h1>
            {result.state === 'ready' && result.data.total > 0 ? (
              <span className="rounded-full bg-[var(--color-primary-soft)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-on-primary-soft)]">
                {result.data.total}
              </span>
            ) : null}
          </div>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/admin">К рабочим очередям</Link>
        </Button>
      </div>

      {result.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={result.correlationId}
          message="Очередь заявок временно не загрузилась. Повторите запрос."
        />
      ) : result.data.items.length === 0 ? (
        <AdminEmptyState>Новых заявок на проверку нет.</AdminEmptyState>
      ) : (
        <>
          <AccountApprovalQueue items={result.data.items} />
          <AdminPagination
            total={result.data.total}
            visible={result.data.items.length}
            pageIndex={trail.length}
            pageSize={ADMIN_PAGE_SIZE}
            firstHref={approvalHref('', [])}
            previousHref={
              previousToken === null ? null : approvalHref(previousToken, trail.slice(0, -1))
            }
            nextHref={
              result.data.hasMore && result.data.nextCursor
                ? approvalHref(
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
