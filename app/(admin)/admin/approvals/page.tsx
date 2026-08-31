export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { AccountApprovalQueue } from '@/components/admin/account-approval-queue';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { Button } from '@/components/ui/button';
import {
  getPendingAccountApprovalPage,
  parseAdminAccountApprovalQuery,
  type AdminAccountApprovalQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';

function approvalHref(
  query: AdminAccountApprovalQuery,
  cursor: AdminAccountApprovalQuery,
) {
  const params = new URLSearchParams();
  if (cursor.cursorAt && cursor.cursorId) {
    params.set('cursorAt', cursor.cursorAt);
    params.set('cursorId', cursor.cursorId);
  }
  const search = params.toString();
  return search ? `/admin/approvals?${search}` : '/admin/approvals';
}

export default async function AdminApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminSearchParams>;
}) {
  const query = parseAdminAccountApprovalQuery(await searchParams);
  const result = await getPendingAccountApprovalPage(query);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-primary)]">Ручная проверка доступа</p>
          <h1 className="font-display mt-1 text-3xl font-bold">Заявки на обучение</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--color-text-muted)]">
            Подтверждение открывает только доступ к курсам и тестам. Сертификаты по-прежнему требуют отдельной проверки личности.
          </p>
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
            hasCursor={Boolean(query.cursorAt && query.cursorId)}
            firstHref={approvalHref(query, { cursorAt: null, cursorId: null })}
            nextHref={
              result.data.hasMore && result.data.nextCursor
                ? approvalHref(query, {
                    cursorAt: result.data.nextCursor.at,
                    cursorId: result.data.nextCursor.id,
                  })
                : null
            }
          />
        </>
      )}
    </section>
  );
}
