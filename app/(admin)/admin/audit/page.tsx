export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireCapability } from '@/features/auth/server';
import {
  getAdminAuditPage,
  parseAdminAuditQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';
import { ResultsExport } from '@/components/admin/results-export';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminDetailDialog } from '@/components/admin/admin-detail-dialog';
import { AdminPagination } from '@/components/admin/admin-pagination';

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

type EventCategory = 'user' | 'test' | 'certificate' | 'technical';

function eventCategory(action: string, details: Record<string, unknown>): EventCategory {
  if (action.startsWith('certificate')) return 'certificate';
  if (action.includes('test') || action.includes('attempt') || 'score' in details) return 'test';
  if (
    action.includes('invite') ||
    action.startsWith('identity') ||
    action.includes('register') ||
    action.startsWith('user') ||
    action.includes('approval')
  ) {
    return 'user';
  }
  return 'technical';
}

function categoryBadge(category: EventCategory) {
  switch (category) {
    case 'certificate':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-primary-soft)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-on-primary-soft)]">
          🎓 Сертификат
        </span>
      );
    case 'test':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-primary-soft)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-on-primary-soft)]">
          📝 Тестирование
        </span>
      );
    case 'user':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-text)]">
          👤 Пользователь
        </span>
      );
    case 'technical':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-text-muted)]">
          ⚙️ Системный лог
        </span>
      );
  }
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
  const auditResult = await getAdminAuditPage(query);

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

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-4 text-xs">
        <span className="font-semibold text-[var(--color-text-muted)]">Быстрый фильтр:</span>
        <Link
          href="/admin/settings/history"
          className={`rounded-lg px-3 py-1.5 font-bold transition-colors ${
            !query.action
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
          }`}
        >
          Все события
        </Link>
        <Link
          href="/admin/settings/history?action=identity"
          className={`rounded-lg px-3 py-1.5 font-bold transition-colors ${
            query.action === 'identity'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
          }`}
        >
          Регистрации и доступ
        </Link>
        <Link
          href="/admin/settings/history?action=test"
          className={`rounded-lg px-3 py-1.5 font-bold transition-colors ${
            query.action === 'test'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
          }`}
        >
          Тесты и баллы
        </Link>
        <Link
          href="/admin/settings/history?action=certificate"
          className={`rounded-lg px-3 py-1.5 font-bold transition-colors ${
            query.action === 'certificate'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
          }`}
        >
          Сертификаты
        </Link>
      </div>

      {auditResult.state === 'failed' ? (
        <AdminLoadFailure correlationId={auditResult.correlationId} />
      ) : auditResult.data.items.length === 0 ? (
        <AdminEmptyState>События по выбранным фильтрам не найдены.</AdminEmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-[var(--color-surface)]">
          <div className="hidden min-h-10 grid-cols-[140px_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_70px] items-center gap-3 bg-[var(--color-surface-muted)] px-3 text-xs font-bold text-[var(--color-text-muted)] md:grid border-b">
            <span>Время</span>
            <span>Действие</span>
            <span>Инициатор</span>
            <span>Цель / Результат</span>
            <span className="text-right">Детали</span>
          </div>
          {auditResult.data.items.map((event) => {
            const category = eventCategory(event.action, event.details);
            const score = typeof event.details.score === 'number' ? event.details.score : undefined;
            const total = typeof event.details.total === 'number' ? event.details.total : undefined;
            const certNum =
              typeof event.details.certificateNumber === 'string'
                ? event.details.certificateNumber
                : undefined;

            return (
              <div
                key={event.id}
                className="grid min-h-12 items-center gap-2 border-b px-3 py-2 text-xs transition-colors hover:bg-[var(--color-surface-muted)]/50 last:border-b-0 md:grid-cols-[140px_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_70px] md:gap-3"
              >
                <time className="text-[var(--color-text-muted)] font-mono text-[11px]">
                  {new Date(event.createdAt).toLocaleString('ru-RU', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                <div className="min-w-0 flex items-center gap-1.5">
                  {categoryBadge(category)}
                  <span className="font-semibold text-[var(--color-text)] truncate" title={readableAction(event.action)}>
                    {readableAction(event.action)}
                  </span>
                </div>
                <div className="min-w-0 truncate text-[var(--color-text)]" title={event.actorLabel}>
                  {event.actorLabel}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[var(--color-text)]" title={event.targetLabel}>
                    {event.targetLabel}
                  </div>
                  {score !== undefined && total !== undefined ? (
                    <span className="mt-0.5 inline-block text-[11px] font-medium text-[var(--color-text-muted)]">
                      Результат: {score}/{total} {score >= 7 ? '(Сдан)' : '(Не сдан)'}
                    </span>
                  ) : null}
                  {certNum ? (
                    <span className="mt-0.5 inline-block text-[11px] font-medium text-[var(--color-primary)]">
                      № {certNum}
                    </span>
                  ) : null}
                </div>
                <div className="flex justify-end">
                  <AdminDetailDialog
                    title={readableAction(event.action)}
                    description={`${event.actorLabel} → ${event.targetLabel}`}
                    triggerLabel="Детали"
                  >
                    <div className="space-y-4 text-sm">
                      <dl className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">Автор</dt>
                          <dd className="mt-1 break-words">{event.actorLabel}</dd>
                        </div>
                        <div>
                          <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">Цель</dt>
                          <dd className="mt-1 break-words">{event.targetLabel}</dd>
                        </div>
                        {detailStatus(event.details) ? (
                          <div>
                            <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">Статус</dt>
                            <dd className="mt-1">{detailStatus(event.details)}</dd>
                          </div>
                        ) : null}
                        <div>
                          <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">Время</dt>
                          <dd className="mt-1">{new Date(event.createdAt).toLocaleString('ru-RU')}</dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">Correlation ID</dt>
                          <dd className="mt-1 font-mono text-xs break-all">{event.correlationId}</dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">Технические идентификаторы</dt>
                          <dd className="mt-1 font-mono text-xs break-all">Action: {event.action} · Target: {event.targetId ?? '—'} · Event: {event.id}</dd>
                        </div>
                      </dl>
                      <div>
                        <h3 className="font-semibold text-xs">Данные события</h3>
                        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs break-words whitespace-pre-wrap">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </AdminDetailDialog>
                </div>
              </div>
            );
          })}
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
