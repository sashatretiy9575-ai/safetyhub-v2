export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Buildings, Certificate, CheckCircle } from '@phosphor-icons/react/dist/ssr';
import { AttestationsFilterForm } from '@/components/admin/attestations-filter-form';
import { AttestationsManager } from '@/components/admin/attestations-manager';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { Button } from '@/components/ui/button';
import {
  encodeAdminAttestationCursor,
  getAdminAttestationsPage,
  getAdminWorkQueue,
  parseAdminAttestationQuery,
  type AdminAttestationQuery,
  type RawAdminAttestationSearchParams,
} from '@/features/admin/attestations';
import { requireCapability } from '@/features/auth/server';

function inputDate(value: string | null, exclusiveEnd = false) {
  if (!value) return '';
  const date = new Date(value);
  if (exclusiveEnd) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function employeeHref(query: AdminAttestationQuery, cursor: AdminAttestationQuery['cursor']) {
  const params = new URLSearchParams();
  if (query.query) params.set('q', query.query);
  if (query.organization) params.set('organization', query.organization);
  if (query.testId) params.set('course', query.testId);
  if (query.resultState) params.set('result', query.resultState);
  if (query.certificateState) params.set('certificate', query.certificateState);
  if (query.from) params.set('from', inputDate(query.from));
  if (query.to) params.set('to', inputDate(query.to, true));
  if (query.sort !== 'organization_asc') params.set('sort', query.sort);
  if (query.pageSize !== 50) params.set('pageSize', String(query.pageSize));
  const encodedCursor = encodeAdminAttestationCursor(cursor);
  if (encodedCursor) params.set('cursor', encodedCursor);
  const search = params.toString();
  return search ? `/admin/employees?${search}` : '/admin/employees';
}

export default async function AdminEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminAttestationSearchParams>;
}) {
  const params = await searchParams;
  const parsed = parseAdminAttestationQuery(params);
  const query: AdminAttestationQuery =
    params.sort === undefined ? { ...parsed, sort: 'organization_asc' } : parsed;
  const actor = await requireCapability('results.read');
  const [result, queueResult] = await Promise.all([
    getAdminAttestationsPage(query),
    getAdminWorkQueue(),
  ]);

  const permissions = {
    canReadUser: actor.capabilities.includes('user.read'),
    canReadIdentity: actor.capabilities.includes('identity.read'),
    canReadCertificate: actor.capabilities.includes('certificate.read'),
    canManageIdentity: actor.capabilities.includes('identity.manage'),
    canIssue: actor.capabilities.includes('certificate.issue'),
    canRevoke: actor.capabilities.includes('certificate.revoke'),
    canExport:
      actor.capabilities.includes('results.export') &&
      actor.capabilities.includes('certificate.read'),
    canDeleteHistory: actor.capabilities.includes('results.delete'),
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-bold">Сотрудники</h1>
        <div className="flex flex-wrap items-center gap-3">
          {result.state === 'ready' ? (
            <p className="text-sm font-bold text-[var(--color-text-muted)] tabular-nums">
              Найдено: {result.data.total}
            </p>
          ) : null}
          {permissions.canDeleteHistory ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/employees/directory">Все аккаунты и история</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {queueResult.state === 'ready' ? (
        <nav
          aria-label="Рабочие очереди"
          className="grid overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm sm:grid-cols-3"
        >
          {[
            {
              href: '/admin/employees?certificate=pending_identity&sort=organization_asc',
              label: 'Требуют проверки',
              count: queueResult.data.pendingIdentity,
              icon: CheckCircle,
            },
            {
              href: '/admin/employees?certificate=ready&sort=organization_asc',
              label: 'Готовы к выдаче',
              count: queueResult.data.readyToIssue,
              icon: Certificate,
            },
            {
              href: '/admin/organizations/cleanup',
              label: 'Ошибки в компаниях',
              count: queueResult.data.companyIssues,
              icon: Buildings,
            },
          ].map(({ href, label, count, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex min-h-12 items-center gap-3 border-b px-4 py-2.5 text-sm font-semibold transition-colors last:border-b-0 hover:bg-[var(--color-surface-muted)] sm:border-r sm:border-b-0 sm:last:border-r-0"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <Icon aria-hidden size={18} />
              </span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <strong className="text-base font-bold tabular-nums">{count}</strong>
            </Link>
          ))}
        </nav>
      ) : null}

      <AttestationsFilterForm
        values={{
          query: query.query,
          organization: query.organization,
          testId: query.testId,
          resultState: query.resultState,
          certificateState: query.certificateState,
          from: inputDate(query.from),
          to: inputDate(query.to, true),
          sort: query.sort,
          pageSize: query.pageSize,
        }}
      />

      {result.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={result.correlationId}
          message="Рабочий список временно не загрузился. Повторите запрос."
        />
      ) : result.data.items.length === 0 ? (
        <AdminEmptyState>По выбранным фильтрам сотрудники не найдены.</AdminEmptyState>
      ) : (
        <>
          <AttestationsManager
            key={employeeHref(query, query.cursor)}
            page={result.data}
            filters={{
              query: query.query,
              organization: query.organization,
              testId: query.testId,
              resultState: query.resultState,
              certificateState: query.certificateState,
              from: query.from,
              to: query.to,
              sort: query.sort,
              pageSize: query.pageSize,
            }}
            permissions={permissions}
          />
          <AdminPagination
            total={result.data.total}
            visible={result.data.items.length}
            hasCursor={Boolean(query.cursor)}
            firstHref={employeeHref(query, null)}
            nextHref={
              result.data.hasMore && result.data.nextCursor
                ? employeeHref(query, result.data.nextCursor)
                : null
            }
          />
        </>
      )}
    </section>
  );
}
