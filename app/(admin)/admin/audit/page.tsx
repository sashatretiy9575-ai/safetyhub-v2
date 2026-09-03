export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireCapability } from '@/features/auth/server';
import {
  ADMIN_PAGE_SIZE,
  getAdminAuditPage,
  parseAdminAuditQuery,
  type RawAdminSearchParams,
} from '@/features/admin/data';
import {
  ADMIN_TRAIL_PARAM,
  appendAdminTrail,
  parseAdminTrail,
  serializeAdminTrail,
} from '@/lib/admin/pagination-trail';
import { ResultsExport } from '@/components/admin/results-export';
import { AdminEmptyState, AdminLoadFailure } from '@/components/admin/admin-data-state';
import { AdminDetailDialog } from '@/components/admin/admin-detail-dialog';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  'course.question_bank_read': 'Открыт банк вопросов курса',
  'article.status': 'Изменён статус статьи',
  'auth_admin.reconcile_claim': 'Запущено согласование Auth Admin',
  'account.approval_requested': 'Подана заявка на доступ',
  'account.approval.approved': 'Заявка на доступ одобрена',
  'account.approval.rejected': 'Заявка на доступ отклонена',
  'admin.provisioned_by_email': 'Администратор назначен по адресу почты',
  'superadmin.bootstrapped': 'Создан первый администратор',
  'role.changed': 'Изменена роль',
  'role.changed_directly': 'Роль изменена напрямую в базе',
  'capabilities.changed': 'Изменены права доступа',
  'learning_history.deleted': 'Удалена история обучения',
  'organization.merged': 'Объединены компании',
  'site.settings_updated': 'Изменены настройки сайта',
  'notification.delivery_retried': 'Повторная отправка уведомления',
  'auth_operation.claimed': 'Взята в работу операция входа',
  'course.draft_saved': 'Сохранён черновик курса',
  'course.draft_reviewed': 'Черновик курса проверен',
  'course.published': 'Курс опубликован',
  'course.deleted': 'Курс удалён',
  'course.slug_changed': 'Изменён адрес курса',
  'course.unused_draft_deleted': 'Удалён неиспользуемый черновик курса',
  'course.localization_saved': 'Сохранён перевод курса',
  'course.localizations_published': 'Опубликованы переводы курса',
  'course.localization_assessment_imported': 'Загружены переводы вопросов курса',
  'course.presentation_finalized': 'Презентация курса сохранена',
  'course.presentation_retired': 'Презентация курса выведена из работы',
  'test.draft_saved': 'Сохранён черновик теста',
  'test.published': 'Тест опубликован',
  'test.status_changed': 'Изменён статус теста',
  'article.draft_saved': 'Сохранён черновик статьи',
  'article.draft_reviewed': 'Черновик статьи проверен',
  'article.published': 'Статья опубликована',
  'article.deleted': 'Статья удалена',
  'article.status_changed': 'Изменён статус статьи',
  'article.localization_saved': 'Сохранён перевод статьи',
  'article.localizations_published': 'Опубликованы переводы статьи',
  'legal.version_staged': 'Подготовлена редакция документа',
  'legal.version_published': 'Опубликована редакция документа',
  'legal.bundle_published': 'Опубликован комплект документов',
  'legal.localization_saved': 'Сохранён перевод документа',
  'legal.localizations_published': 'Опубликованы переводы документов',
  'certificate.issued': 'Сертификат выдан',
  'certificate.revoked': 'Сертификат отозван',
  'certificate.exported': 'Сертификаты выгружены',
  'certificate.export_job.created': 'Создана выгрузка сертификатов',
  'certificate.export_job.downloaded': 'Скачана выгрузка сертификатов',
  'catalog.replaced': 'Каталог заменён',
  'catalog.batch_prepared': 'Подготовлена загрузка каталога',
  'catalog.initial_import_activated': 'Первичная загрузка каталога включена',
  'catalog.maintenance_enabled': 'Включён режим обслуживания каталога',
  'catalog.maintenance_disabled': 'Выключен режим обслуживания каталога',
  'content_asset.delete_prepared': 'Подготовлено удаление файла',
  'content_asset.orphan_marked': 'Файл отмечен как неиспользуемый',
  'zh_username_password.created': 'Создан китайский аккаунт (логин и пароль)',
  'zh_username_password.provisioning_started': 'Начата выдача китайского доступа',
  'zh_username_password.reset_started': 'Начата смена китайского пароля',
  'zh_username_password.reset_completed': 'Китайский пароль изменён',
  'zh_credential.reset': 'Сброшен китайский доступ',
};

const bulkAttestationLabels: Record<string, string> = {
  confirm: 'Массовое подтверждение результатов',
  update: 'Массовое изменение результатов',
  issue: 'Массовая выдача сертификатов',
  revoke: 'Массовый отзыв сертификатов',
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

const quickFilters = [
  { value: '', label: 'Все события' },
  { value: 'identity', label: 'Регистрации и доступ' },
  { value: 'test', label: 'Тесты и баллы' },
  { value: 'certificate', label: 'Сертификаты' },
] as const;

function readableAction(action: string) {
  if (actionLabels[action]) return actionLabels[action];
  const operation = action.match(/^auth_admin\.(invite|suspend|restore|delete)\.([a-z_]+)$/);
  if (operation) {
    const operationName = operation[1] ?? '';
    const status = operation[2] ?? '';
    return `${operationLabels[operationName] ?? operationName}: ${statusLabels[status] ?? status}`;
  }
  const bulk = action.match(/^attestation.bulk.([a-z_]+)$/u);
  if (bulk) {
    const name = bulk[1] ?? '';
    return bulkAttestationLabels[name] ?? `Массовая операция: ${name}`;
  }
  const words = action.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nested(details: Record<string, unknown>, key: 'before' | 'after') {
  const value = details[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The RPC packs the event payload into `before`/`after`/`reason`/`batchId`, so
 * a status lives one level down. The previous version only read the flat keys
 * and therefore never showed a status at all.
 */
function detailStatus(details: Record<string, unknown>) {
  const candidates = [
    details.status,
    details.state,
    details.to,
    nested(details, 'after')?.status,
    nested(details, 'after')?.state,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return statusLabels[candidate] ?? candidate;
  }
  return null;
}

function detailReason(details: Record<string, unknown>) {
  return typeof details.reason === 'string' && details.reason.trim() ? details.reason : null;
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

const categoryStyles: Record<EventCategory, { label: string; className: string }> = {
  certificate: {
    label: 'Сертификат',
    className: 'bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]',
  },
  test: {
    label: 'Тест',
    className: 'bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]',
  },
  user: {
    label: 'Аккаунт',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-text)]',
  },
  technical: {
    label: 'Система',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  },
};

function auditFilterParams(query: ReturnType<typeof parseAdminAuditQuery>) {
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
  return params;
}

function auditPageHref(
  query: ReturnType<typeof parseAdminAuditQuery>,
  cursorToken: string,
  trail: readonly string[],
) {
  const params = auditFilterParams(query);
  if (cursorToken) {
    const [at = '', id = ''] = cursorToken.split('|');
    params.set('cursorAt', at);
    params.set('cursorId', id);
  }
  const serialized = serializeAdminTrail(trail);
  if (serialized) params.set(ADMIN_TRAIL_PARAM, serialized);
  const encoded = params.toString();
  return encoded ? `/admin/settings/history?${encoded}` : '/admin/settings/history';
}

function quickFilterHref(query: ReturnType<typeof parseAdminAuditQuery>, action: string) {
  const params = auditFilterParams(query);
  params.delete('action');
  if (action) params.set('action', action);
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

  const trail = parseAdminTrail(params[ADMIN_TRAIL_PARAM]);
  const currentToken = query.cursorAt && query.cursorId ? `${query.cursorAt}|${query.cursorId}` : '';
  const previousToken = trail.length > 0 ? (trail[trail.length - 1] ?? '') : null;
  const fromValue = query.from ? query.from.slice(0, 10) : '';
  const toValue = query.to
    ? new Date(new Date(query.to).setUTCDate(new Date(query.to).getUTCDate() - 1))
        .toISOString()
        .slice(0, 10)
    : '';
  const hasFilters = Boolean(query.actor || query.target || query.action || query.from || query.to);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">История действий</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Кто и что изменил в системе. Записи только читаются и не редактируются.
          </p>
        </div>
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

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {quickFilters.map(({ value, label }) => {
          const active = (query.action ?? '') === value;
          return (
            <Link
              key={value || 'all'}
              href={quickFilterHref(query, value)}
              aria-current={active ? 'true' : undefined}
              className={`inline-flex min-h-9 items-center rounded-full px-3 font-semibold transition-colors ${
                active
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <form className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:grid-cols-2 sm:items-end lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9.5rem_9.5rem_auto_auto]">
        {query.action ? <input type="hidden" name="action" value={query.action} /> : null}
        <div className="space-y-1">
          <Label htmlFor="audit-actor" className="text-xs">
            Кто (инициатор)
          </Label>
          <Input id="audit-actor" name="actor" defaultValue={query.actor} maxLength={100} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-target" className="text-xs">
            Над кем / над чем
          </Label>
          <Input id="audit-target" name="target" defaultValue={query.target} maxLength={100} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-from" className="text-xs">
            С даты
          </Label>
          <Input id="audit-from" name="from" type="date" defaultValue={fromValue} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-to" className="text-xs">
            По дату
          </Label>
          <Input id="audit-to" name="to" type="date" defaultValue={toValue} />
        </div>
        <Button type="submit" size="sm" className="h-11">
          Показать
        </Button>
        {hasFilters ? (
          <Button asChild type="button" size="sm" variant="outline" className="h-11">
            <Link href="/admin/settings/history">Сбросить</Link>
          </Button>
        ) : null}
      </form>

      {auditResult.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={auditResult.correlationId}
          message="Журнал временно не загрузился. Повторите запрос."
        />
      ) : auditResult.data.items.length === 0 ? (
        <AdminEmptyState>События по выбранным фильтрам не найдены.</AdminEmptyState>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="hidden min-h-10 grid-cols-[9.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_5rem] items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 text-xs font-bold text-[var(--color-text-muted)] lg:grid">
              <span>Когда</span>
              <span>Что произошло</span>
              <span>Кто</span>
              <span>Над кем / над чем</span>
              <span className="text-right">Детали</span>
            </div>

            {auditResult.data.items.map((event) => {
              const category = eventCategory(event.action, event.details);
              const style = categoryStyles[category];
              const status = detailStatus(event.details);
              const reason = detailReason(event.details);
              const created = new Date(event.createdAt);

              return (
                <div
                  key={event.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-3 py-2.5 text-xs transition-colors last:border-b-0 hover:bg-[var(--color-surface-muted)]/60 lg:min-h-12 lg:grid-cols-[9.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_5rem] lg:items-center"
                >
                  <time
                    dateTime={event.createdAt}
                    className="order-2 font-mono text-[11px] whitespace-nowrap text-[var(--color-text-subtle)] lg:order-none"
                  >
                    {created.toLocaleDateString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      year: '2-digit',
                    })}
                    <span className="ml-1.5 text-[var(--color-text-muted)]">
                      {created.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </time>

                  <div className="order-1 col-span-2 min-w-0 lg:order-none lg:col-span-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${style.className}`}
                      >
                        {style.label}
                      </span>
                      <span className="min-w-0 font-semibold text-[var(--color-text)]">
                        {readableAction(event.action)}
                      </span>
                      {status ? (
                        <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                          · {status}
                        </span>
                      ) : null}
                    </div>
                    {reason ? (
                      <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-subtle)]">
                        {reason}
                      </p>
                    ) : null}
                  </div>

                  <div
                    className="order-3 min-w-0 truncate text-[var(--color-text-muted)] lg:order-none lg:text-[var(--color-text)]"
                    title={event.actorLabel}
                  >
                    {event.actorLabel}
                  </div>

                  <div
                    className="order-4 col-span-2 min-w-0 truncate text-[var(--color-text-muted)] lg:order-none lg:col-span-1 lg:text-[var(--color-text)]"
                    title={event.targetLabel}
                  >
                    {event.targetLabel}
                  </div>

                  <div className="order-2 flex justify-end lg:order-none">
                    <AdminDetailDialog
                      title={readableAction(event.action)}
                      description={`${event.actorLabel} → ${event.targetLabel}`}
                      triggerLabel="Детали"
                    >
                      <div className="space-y-4 text-sm">
                        <dl className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                              Кто
                            </dt>
                            <dd className="mt-1 break-words">{event.actorLabel}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                              Над кем / над чем
                            </dt>
                            <dd className="mt-1 break-words">{event.targetLabel}</dd>
                          </div>
                          {status ? (
                            <div>
                              <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                                Статус
                              </dt>
                              <dd className="mt-1">{status}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                              Когда
                            </dt>
                            <dd className="mt-1">{created.toLocaleString('ru-RU')}</dd>
                          </div>
                          {reason ? (
                            <div className="sm:col-span-2">
                              <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                                Причина
                              </dt>
                              <dd className="mt-1 break-words">{reason}</dd>
                            </div>
                          ) : null}
                          <div className="sm:col-span-2">
                            <dt className="text-xs font-semibold text-[var(--color-text-subtle)]">
                              Код обращения
                            </dt>
                            <dd className="mt-1 font-mono text-xs break-all">
                              {event.correlationId}
                            </dd>
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
                          <h3 className="text-xs font-semibold">Данные события</h3>
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

          <AdminPagination
            total={auditResult.data.total}
            visible={auditResult.data.items.length}
            pageIndex={trail.length}
            pageSize={ADMIN_PAGE_SIZE}
            firstHref={auditPageHref(query, '', [])}
            previousHref={
              previousToken === null
                ? null
                : auditPageHref(query, previousToken, trail.slice(0, -1))
            }
            nextHref={
              auditResult.data.hasMore && auditResult.data.nextCursor
                ? auditPageHref(
                    query,
                    `${auditResult.data.nextCursor.at}|${auditResult.data.nextCursor.id}`,
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
