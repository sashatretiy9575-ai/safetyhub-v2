export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireCapability } from '@/features/auth/server';
import {
  getAdminAuditPage,
  getAdminDataSummary,
  parseAdminAuditQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';
import { ResultsExport } from '@/components/admin/results-export';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminDetailDialog } from '@/components/admin/admin-detail-dialog';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const actionLabels: Record<string, string> = {
  'role.bootstrap_superadmin': 'Восстановлен административный доступ (архив)',
  'role.update': 'Изменена роль',
  'role.break_glass_superadmin': 'Аварийно восстановлен административный доступ (архив)',
  'admin.break_glass_restored': 'Аварийно восстановлен административный доступ',
  'user.suspend': 'Пользователь заблокирован',
  'user.restore': 'Пользователь восстановлен',
  'user.suspend_requested': 'Запрошена блокировка пользователя',
  'user.restore_requested': 'Запрошено восстановление пользователя',
  'user.delete_prepare': 'Подготовлено удаление пользователя',
  'user.delete_requested': 'Запрошено удаление пользователя',
  'user.delete_confirmed': 'Подтверждено удаление пользователя',
  'capability.set': 'Изменена прежняя конфигурация доступа',
  'identity.verified': 'Личность подтверждена',
  'identity.revoked': 'Подтверждение личности отозвано',
  'certificate.revoke': 'Сертификат отозван',
  'certificate.auto_revoked_identity_migration': 'Сертификат автоматически отозван',
  'certificate.revoke_legacy_backfill': 'Зафиксирован прежний отзыв сертификата',
  'test.status': 'Изменён статус теста',
  'article.status': 'Изменён статус статьи',
  'auth_admin.reconcile_claim': 'Запущено согласование Auth Admin',
};

const operationLabels: Record<string, string> = {
  invite: 'Приглашение пользователя',
  suspend: 'Блокировка пользователя',
  restore: 'Восстановление пользователя',
  delete: 'Удаление пользователя',
};

const statusLabels: Record<string, string> = {
  started: 'В процессе',
  completed: 'Завершено',
  passed: 'Пройдено',
  failed: 'Ошибка',
  expired: 'Время истекло',
  prepared: 'Подготовлено',
  confirmed: 'Подтверждено',
  external_succeeded: 'Внешняя операция выполнена',
  committed: 'Зафиксировано',
  retryable: 'Ожидает повтора',
  rolled_back: 'Откачено',
  active: 'Активно',
  suspended: 'Заблокировано',
  published: 'Опубликовано',
  draft: 'Черновик',
  revoked: 'Отозвано',
};

function readableAction(action: string) {
  if (actionLabels[action]) return actionLabels[action];
  const operation = action.match(/^auth_admin\.(invite|suspend|restore|delete)\.([a-z_]+)$/);
  if (operation) {
    const operationName = operation[1] ?? '';
    const status = operation[2] ?? '';
    return `${operationLabels[operationName] ?? operationName}: ${statusLabels[status] ?? status}`;
  }
  const words = action.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function detailStatus(details: Record<string, unknown>) {
  const direct = details.status ?? details.state;
  if (typeof direct === 'string') return statusLabels[direct] ?? direct;
  const next = details.to;
  if (typeof next === 'string') return statusLabels[next] ?? next;
  if (next && typeof next === 'object' && 'status' in next) {
    const nested = next.status;
    if (typeof nested === 'string') return statusLabels[nested] ?? nested;
  }
  return null;
}

function value(params: RawAdminSearchParams, key: string) {
  const item = params[key];
  return (Array.isArray(item) ? item[0] : item) ?? '';
}

function auditPageHref(
  query: ReturnType<typeof parseAdminAuditQuery>,
  cursor: { at: string; id: string } | null,
) {
  const params = new URLSearchParams();
  if (query.actor) params.set('actor', query.actor);
  if (query.target) params.set('target', query.target);
  if (query.action) params.set('action', query.action);
  if (query.from) params.set('from', query.from.slice(0, 10));
  if (query.to) {
    const to = new Date(query.to);
    to.setUTCDate(to.getUTCDate() - 1);
    params.set('to', to.toISOString().slice(0, 10));
  }
  if (cursor) {
    params.set('cursorAt', cursor.at);
    params.set('cursorId', cursor.id);
  }
  const encoded = params.toString();
  return encoded ? `/admin/settings/history?${encoded}` : '/admin/settings/history';
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminSearchParams>;
}) {
  const params = await searchParams;
  const query = parseAdminAuditQuery(params);
  await requireCapability('audit.read');
  const [auditResult, summaryResult] = await Promise.all([
    getAdminAuditPage(query),
    getAdminDataSummary(),
  ]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-display text-3xl font-bold">Журнал аудита</h1>
        {auditResult.state === 'ready' ? (
          <ResultsExport
            filename="audit-page"
            rows={auditResult.data.items.map((event) => ({
              время: event.createdAt,
              автор: event.actorLabel,
              действие: readableAction(event.action),
              цель: event.targetLabel,
              correlation_id: event.correlationId,
              детали: event.details,
              id: event.id,
            }))}
          />
        ) : null}
      </div>

      {summaryResult.state === 'ready' ? (
        <div className="grid gap-3 min-[420px]:grid-cols-2">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[var(--color-text-muted)]">Событий за 24 часа</p>
              <p className="text-2xl font-black tabular-nums">
                {summaryResult.data.auditEvents24h ?? '—'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[var(--color-text-muted)]">Найдено по фильтрам</p>
              <p className="text-2xl font-black tabular-nums">
                {auditResult.state === 'ready' ? auditResult.data.total : '—'}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <AdminLoadFailure
          correlationId={summaryResult.correlationId}
          message="Сводка аудита не загрузилась. Сам журнал может оставаться доступным."
        />
      )}

      <form method="get" className="grid gap-3 rounded-xl border p-4 md:grid-cols-2 lg:grid-cols-5">
        <Input
          name="actor"
          defaultValue={query.actor}
          placeholder="Автор: имя, email или UUID"
          aria-label="Фильтр по автору"
        />
        <Input
          name="target"
          defaultValue={query.target}
          placeholder="Цель: название, тип или UUID"
          aria-label="Фильтр по цели"
        />
        <Input
          name="action"
          defaultValue={query.action}
          placeholder="Действие, например user.suspend"
          aria-label="Фильтр по действию"
        />
        <Input type="date" name="from" defaultValue={value(params, 'from')} aria-label="С даты" />
        <Input type="date" name="to" defaultValue={value(params, 'to')} aria-label="По дату" />
        <div className="flex flex-wrap gap-2 md:col-span-2 lg:col-span-5">
          <Button type="submit" size="sm">
            Применить
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/settings/history" prefetch={false}>
              Сбросить
            </Link>
          </Button>
        </div>
      </form>

      {auditResult.state === 'failed' ? (
        <AdminLoadFailure correlationId={auditResult.correlationId} />
      ) : auditResult.data.items.length === 0 ? (
        <AdminEmptyState>События по выбранным фильтрам не найдены.</AdminEmptyState>
      ) : (
        <div className="space-y-3">
          {auditResult.data.items.map((event) => (
            <Card key={event.id}>
              <CardContent className="space-y-3 p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold">{readableAction(event.action)}</h2>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      {event.actorLabel} → {event.targetLabel}
                    </p>
                  </div>
                  <time className="text-xs text-[var(--color-text-muted)]">
                    {new Date(event.createdAt).toLocaleString('ru-RU')}
                  </time>
                </div>
                <AdminDetailDialog
                  title={readableAction(event.action)}
                  description={`${event.actorLabel} → ${event.targetLabel}`}
                  triggerLabel="Открыть событие"
                >
                  <div className="space-y-5 text-sm">
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                          Автор
                        </dt>
                        <dd className="mt-1 break-words">{event.actorLabel}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                          Цель
                        </dt>
                        <dd className="mt-1 break-words">{event.targetLabel}</dd>
                      </div>
                      {detailStatus(event.details) ? (
                        <div>
                          <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                            Статус
                          </dt>
                          <dd className="mt-1">{detailStatus(event.details)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                          Время
                        </dt>
                        <dd className="mt-1">
                          {new Date(event.createdAt).toLocaleString('ru-RU')}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                          Correlation ID
                        </dt>
                        <dd className="mt-1 font-mono text-xs break-all">{event.correlationId}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                          Технические идентификаторы
                        </dt>
                        <dd className="mt-1 font-mono text-xs break-all">
                          Action: {event.action} · Target: {event.targetId ?? '—'} · Event:{' '}
                          {event.id}
                        </dd>
                      </div>
                    </dl>
                    <div>
                      <h3 className="font-semibold">Данные события</h3>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs break-words whitespace-pre-wrap">
                        {JSON.stringify(event.details, null, 2)}
                      </pre>
                    </div>
                  </div>
                </AdminDetailDialog>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {auditResult.state === 'ready' ? (
        <AdminPagination
          total={auditResult.data.total}
          visible={auditResult.data.items.length}
          hasCursor={Boolean(query.cursorAt)}
          firstHref={auditPageHref(query, null)}
          nextHref={
            auditResult.data.hasMore && auditResult.data.nextCursor
              ? auditPageHref(query, auditResult.data.nextCursor)
              : null
          }
        />
      ) : null}
    </section>
  );
}
