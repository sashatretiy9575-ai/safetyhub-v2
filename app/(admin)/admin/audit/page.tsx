export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { CalendarBlank } from '@phosphor-icons/react/dist/ssr/CalendarBlank';
import {
  AUDIT_QUICK_PERIODS,
  AUDIT_TIME_ZONE,
  auditActivePeriod,
  auditDateValue,
  auditInclusiveEndValue,
  auditRecentPeriod,
} from '@/lib/admin/audit-dates';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';
import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';
import {
  ADMIN_PAGE_SIZE,
  getAdminAuditPage,
  parseAdminAuditQuery,
  type RawAdminSearchParams,
} from '@/server/admin/data';
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
  'account.approval.approved': 'Регистрация подтверждена',
  'course.access.changed': 'Изменён доступ к курсам',
  'test.passed': 'Тест пройден',
  'certificate.issued': 'Документ выдан',
  'certificate.revoked': 'Документ отозван',
  'certificate.exported': 'Документы экспортированы',
  'certificate.export_job.created': 'Подготовлен экспорт документов',
  'certificate.export_job.downloaded': 'Архив документов скачан',
  'identity.verified': 'Данные сотрудника подтверждены',
  'identity.revoked': 'Подтверждение данных отменено',
  'identity.bulk_confirm': 'Подтверждены данные выбранных сотрудников',
  'identity.education.update': 'Изменены сведения об образовании',
  'identity.organization_merge': 'Изменена компания сотрудника',
  'organization.merged': 'Компании объединены',
  'organization.merge': 'Объединение компаний',
  'learning_history.deleted': 'Учебная история удалена',
  'user.invited': 'Сотрудник приглашён',
  'user.self_purged': 'Учётная запись удалена пользователем',
  'course.completed': 'Курс завершён',
  'course.deleted': 'Курс удалён',
  'course.draft_saved': 'Черновик курса сохранён',
  'course.draft_reviewed': 'Черновик курса проверен',
  'course.draft_restored_from_revision': 'Черновик курса восстановлен',
  'course.localization_saved': 'Перевод курса сохранён',
  'course.localizations_published': 'Переводы курса опубликованы',
  'course.localization_assessment_imported': 'Загружен перевод вопросов',
  'course.presentation_finalized': 'Презентация курса подготовлена',
  'course.presentation_retired': 'Презентация курса снята с публикации',
  'course.published': 'Курс опубликован',
  'course.question_bank_read': 'Просмотрены вопросы курса',
  'course.slug_changed': 'Изменён адрес курса',
  'course.unused_draft_deleted': 'Неиспользуемый черновик удалён',
  'test.draft_saved': 'Черновик теста сохранён',
  'test.published': 'Тест опубликован',
  'test.status_changed': 'Изменён статус теста',

  'user.self_delete_requested': 'Запрошено удаление учётной записи',
  'user.purged': 'Учётная запись удалена',
  'role.changed': 'Изменена роль пользователя',
  'role.changed_directly': 'Роль изменена напрямую в базе',
  'admin.provisioned_by_email': 'Администратор назначен по адресу почты',
  'superadmin.bootstrapped': 'Создан первый администратор',
  'admin.break_glass_restored': 'Аварийно восстановлен административный доступ',
};

const statusLabels: Record<string, string> = {
  passed: 'Пройдено',
  active: 'Активно',
  approved: 'Подтверждено',
};

const quickFilters = [
  { value: '', label: 'Все события' },
  { value: 'approval', label: 'Регистрации' },
  { value: 'test', label: 'Тесты' },
  { value: 'certificate', label: 'Сертификаты' },
  { value: 'user', label: 'Аккаунты' },
] as const;

// Keyed by the helper's own day counts: a shortcut cannot be offered here
// without `auditActivePeriod` also being able to mark it as applied.
const quickPeriodLabels: Record<(typeof AUDIT_QUICK_PERIODS)[number], string> = {
  1: 'Сегодня',
  7: '7 дней',
  30: '30 дней',
};

function readableAction(action: string) {
  if (actionLabels[action]) return actionLabels[action];
  return 'Другое действие';
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function courseIdList(value: unknown) {
  return Array.isArray(value) &&
    value.every((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id))
    ? value
    : null;
}

/**
 * `set_course_access` replaces a learner's whole set of courses and logs both
 * sets as `before.courseIds` / `after.courseIds`. What the administrator
 * actually did is the difference between the two.
 */
function courseAccessChange(action: string, details: Record<string, unknown>) {
  if (action !== 'course.access.changed') return null;
  const before = courseIdList(nested(details, 'before')?.courseIds);
  const after = courseIdList(nested(details, 'after')?.courseIds);
  if (!before || !after) return null;
  const hadBefore = new Set(before);
  const hasAfter = new Set(after);
  return {
    opened: [...hasAfter].filter((id) => !hadBefore.has(id)),
    closed: [...hadBefore].filter((id) => !hasAfter.has(id)),
  };
}

/**
 * One service-role read names every course the visible page mentions: the
 * catalogue is reference data, not a per-actor read model. Rows arrive in
 * catalogue order, the one the course pickers use. `null` means the lookup
 * itself failed, which must not be passed off as «курс удалён».
 */
async function courseTitlesById(ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  try {
    const { data, error } = await createAdminClient()
      .from('tests')
      .select('id, title')
      .in('id', ids)
      .order('display_order', { ascending: true })
      .order('title', { ascending: true });
    if (error) throw error;
    return new Map<string, string>((data ?? []).map((row) => [row.id, row.title]));
  } catch (error) {
    console.error('ADMIN_AUDIT_COURSE_TITLES_FAILED', {
      cause: safeErrorDiagnosticCode(error, 'UNKNOWN_ADMIN_DATA_ERROR'),
    });
    return null;
  }
}

function courseNames(ids: string[], titles: Map<string, string>) {
  const wanted = new Set(ids);
  return [
    ...[...titles].filter(([id]) => wanted.has(id)).map(([id, title]) => ({ id, title })),
    // A course deleted since then has no row left to take a title from.
    ...ids.filter((id) => !titles.has(id)).map((id) => ({ id, title: 'курс удалён' })),
  ];
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
  if (query.localDates) params.set('tz', 'local');
  if (query.actor) params.set('actor', query.actor);
  if (query.target) params.set('target', query.target);
  if (query.action) params.set('action', query.action);
  if (query.from)
    params.set('from', query.localDates ? auditDateValue(query.from) : query.from.slice(0, 10));
  if (query.to) {
    const to = new Date(query.to);
    to.setUTCDate(to.getUTCDate() - 1);
    params.set(
      'to',
      query.localDates ? auditInclusiveEndValue(query.to) : to.toISOString().slice(0, 10),
    );
  }
  return params;
}

// The page is mounted at two paths, so every link it builds has to keep the
// reader on the one they actually opened.
function auditPageHref(
  basePath: string,
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
  return encoded ? `${basePath}?${encoded}` : basePath;
}

function quickFilterHref(
  basePath: string,
  query: ReturnType<typeof parseAdminAuditQuery>,
  action: string,
) {
  const params = auditFilterParams(query);
  params.delete('action');
  if (action) params.set('action', action);
  const encoded = params.toString();
  return encoded ? `${basePath}?${encoded}` : basePath;
}

export default async function AuditPage({
  searchParams,
  basePath = '/admin/audit',
}: {
  searchParams: Promise<RawAdminSearchParams>;
  basePath?: string;
}) {
  const params = await searchParams;
  const query = parseAdminAuditQuery(params);
  await requireCapability('audit.read');
  const auditResult = await getAdminAuditPage(query);
  const courseTitles = await courseTitlesById([
    ...new Set(
      (auditResult.state === 'ready' ? auditResult.data.items : []).flatMap((event) => {
        const access = courseAccessChange(event.action, event.details);
        return access ? [...access.opened, ...access.closed] : [];
      }),
    ),
  ]);

  const trail = parseAdminTrail(params[ADMIN_TRAIL_PARAM]);
  const currentToken =
    query.cursorAt && query.cursorId ? `${query.cursorAt}|${query.cursorId}` : '';
  const previousToken = trail.length > 0 ? (trail[trail.length - 1] ?? '') : null;
  const filterParams = auditFilterParams(query);
  const fromValue = filterParams.get('from') ?? '';
  const toValue = filterParams.get('to') ?? '';
  const hasFilters = Boolean(query.actor || query.target || query.action || query.from || query.to);
  // One clock for the shortcut links and for the mark on the applied one. A
  // bookmarked UTC range can spell the same dates yet cover other hours, so
  // only local-date filters may light a shortcut up.
  const now = new Date();
  const activePeriod = query.localDates ? auditActivePeriod(fromValue, toValue, now) : null;

  return (
    <section data-audit-workspace className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-h3 font-bold">История действий</h1>
        </div>
        {auditResult.state === 'ready' ? (
          <ResultsExport
            filename="audit-page"
            label="Скачать CSV"
            rows={auditResult.data.items.map((event) => ({
              время: event.createdAt,
              автор: event.actorLabel,
              действие: readableAction(event.action),
              action_code: event.action,
              цель: event.targetLabel,
              correlation_id: event.correlationId,
              детали: event.details,
              id: event.id,
            }))}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-base">
        {quickFilters.map(({ value, label }) => {
          const active = (query.action ?? '') === value;
          return (
            <Link
              key={value || 'all'}
              href={quickFilterHref(basePath, query, value)}
              aria-current={active ? 'true' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-3 font-semibold transition-colors ${
                active
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <form
        key={filterParams.toString()}
        action={basePath}
        className="grid min-w-0 gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {query.action ? <input type="hidden" name="action" value={query.action} /> : null}
        {query.localDates ? <input type="hidden" name="tz" value="local" /> : null}
        <div className="min-w-0 space-y-2">
          <Label htmlFor="audit-actor">Кто выполнил действие</Label>
          <Input
            className="min-w-0 text-base"
            placeholder="Имя или почта"
            id="audit-actor"
            name="actor"
            defaultValue={query.actor}
            maxLength={100}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="audit-target">Сотрудник или объект</Label>
          <Input
            className="min-w-0 text-base"
            placeholder="Имя или название"
            id="audit-target"
            name="target"
            defaultValue={query.target}
            maxLength={100}
          />
        </div>
        {[
          { id: 'from', label: 'С даты', value: fromValue },
          { id: 'to', label: 'По дату включительно', value: toValue },
        ].map(({ id, label, value }) => (
          <div key={id} className="min-w-0 space-y-2">
            <Label htmlFor={`audit-${id}`} className="flex items-center gap-2">
              <CalendarBlank aria-hidden size={18} className="shrink-0" />
              {label}
            </Label>
            <input
              id={`audit-${id}`}
              name={id}
              type="date"
              defaultValue={value}
              className="block min-h-11 w-full max-w-full min-w-0 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-base text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
            />
          </div>
        ))}
        <div className="min-w-0 space-y-2 sm:col-span-2 xl:col-span-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            Даты и время: {query.localDates ? 'Казахстан, UTC+5' : 'UTC (сохранённый фильтр)'}
          </p>
          <div className="flex flex-wrap gap-2" aria-label="Быстрый выбор периода">
            {AUDIT_QUICK_PERIODS.map((days) => {
              const period = auditRecentPeriod(days, now);
              const periodParams = auditFilterParams(query);
              periodParams.set('tz', 'local');
              periodParams.set('from', period.from);
              periodParams.set('to', period.to);
              const active = activePeriod === days;
              return (
                <Link
                  key={days}
                  href={`${basePath}?${periodParams.toString()}`}
                  aria-current={active ? 'true' : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-base font-medium ${
                    active
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'
                  }`}
                >
                  {quickPeriodLabels[days]}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4">
          <Button type="submit" className="min-h-11 text-base">
            Показать
          </Button>
          {hasFilters ? (
            <Button asChild type="button" variant="outline" className="min-h-11 text-base">
              <Link href={basePath}>Сбросить</Link>
            </Button>
          ) : null}
        </div>
      </form>

      {auditResult.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={auditResult.correlationId}
          message="Журнал временно не загрузился. Повторите запрос."
        />
      ) : auditResult.data.items.length === 0 ? (
        <AdminEmptyState>
          {hasFilters
            ? 'События по выбранным фильтрам не найдены.'
            : 'В журнале пока нет действий.'}
        </AdminEmptyState>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {auditResult.data.items.map((event) => {
              const category = eventCategory(event.action, event.details);
              const style = categoryStyles[category];
              const status = detailStatus(event.details);
              const reason = detailReason(event.details);
              const access = courseAccessChange(event.action, event.details);
              const created = new Date(event.createdAt);

              return (
                <div
                  key={event.id}
                  className="grid min-w-0 gap-3 border-b border-[var(--color-border)] p-4 text-base last:border-b-0 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <div className="min-w-0 xl:order-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-sm font-bold ${style.className}`}
                      >
                        {style.label}
                      </span>
                      <span className="min-w-0 font-semibold text-[var(--color-text)]">
                        {readableAction(event.action)}
                      </span>
                      {status ? (
                        <span className="text-sm text-[var(--color-text-muted)]">· {status}</span>
                      ) : null}
                      {access ? (
                        <span className="min-w-0">
                          · открыто {access.opened.length}, закрыто {access.closed.length}
                        </span>
                      ) : null}
                    </div>
                    {reason ? (
                      <p className="mt-2 text-sm text-[var(--color-text-subtle)]">{reason}</p>
                    ) : null}
                  </div>

                  <div className="min-w-0 xl:order-1" title={event.actorLabel}>
                    <span className="block text-sm text-[var(--color-text-muted)]">Кто</span>
                    {event.actorLabel}
                  </div>

                  <div className="min-w-0 xl:order-3" title={event.targetLabel}>
                    <span className="block text-sm text-[var(--color-text-muted)]">
                      Сотрудник или объект
                    </span>
                    {event.targetLabel}
                  </div>

                  <div className="min-w-0 space-y-3 xl:order-4">
                    {/* Label and value stay one block, as in the other columns;
                        the column's spacing only sets the button apart. */}
                    <div>
                      <span className="block text-sm text-[var(--color-text-muted)]">Когда</span>
                      <time
                        dateTime={event.createdAt}
                        className="block text-base text-[var(--color-text)]"
                      >
                        {created.toLocaleDateString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          timeZone: query.localDates ? AUDIT_TIME_ZONE : 'UTC',
                        })}
                        <span className="ml-1.5">
                          {created.toLocaleTimeString('ru-RU', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: query.localDates ? AUDIT_TIME_ZONE : 'UTC',
                          })}
                        </span>
                      </time>
                    </div>

                    <AdminDetailDialog
                      title={readableAction(event.action)}
                      description={`${event.actorLabel} → ${event.targetLabel}`}
                      triggerLabel="Подробности"
                      readable
                    >
                      <div className="space-y-4 text-base">
                        <dl className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                              Кто
                            </dt>
                            <dd className="mt-1 break-words">{event.actorLabel}</dd>
                          </div>
                          <div>
                            <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                              Над кем / над чем
                            </dt>
                            <dd className="mt-1 break-words">{event.targetLabel}</dd>
                          </div>
                          {status ? (
                            <div>
                              <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                                Статус
                              </dt>
                              <dd className="mt-1">{status}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                              Когда
                            </dt>
                            <dd className="mt-1">
                              {created.toLocaleString('ru-RU', {
                                timeZone: query.localDates ? AUDIT_TIME_ZONE : 'UTC',
                              })}
                            </dd>
                          </div>
                          {access && courseTitles
                            ? [
                                { label: 'Открыты', ids: access.opened },
                                { label: 'Закрыты', ids: access.closed },
                              ].map(({ label, ids }) =>
                                ids.length > 0 ? (
                                  <div key={label} className="sm:col-span-2">
                                    <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                                      {label}
                                    </dt>
                                    <dd className="mt-1">
                                      <ul className="list-disc space-y-1 pl-5 [overflow-wrap:anywhere]">
                                        {courseNames(ids, courseTitles).map(({ id, title }) => (
                                          <li key={id}>{title}</li>
                                        ))}
                                      </ul>
                                    </dd>
                                  </div>
                                ) : null,
                              )
                            : null}
                          {reason ? (
                            <div className="sm:col-span-2">
                              <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                                Причина
                              </dt>
                              <dd className="mt-1 break-words">{reason}</dd>
                            </div>
                          ) : null}
                        </dl>
                        <details className="min-w-0">
                          <summary className="min-h-11 cursor-pointer py-3 text-base font-semibold">
                            Технические сведения
                          </summary>
                          <dl className="space-y-3">
                            {' '}
                            <div className="sm:col-span-2">
                              <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                                Код обращения
                              </dt>
                              <dd className="mt-1 font-mono text-sm break-all">
                                {event.correlationId}
                              </dd>
                            </div>
                            <div className="sm:col-span-2">
                              <dt className="text-sm font-semibold text-[var(--color-text-subtle)]">
                                Технические идентификаторы
                              </dt>
                              <dd className="mt-1 font-mono text-sm break-all">
                                Action: {event.action} · Target: {event.targetId ?? '—'} · Event:{' '}
                                {event.id}
                              </dd>
                            </div>
                          </dl>
                          <h3 className="text-sm font-semibold">Данные события</h3>
                          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs break-words whitespace-pre-wrap">
                            {JSON.stringify(event.details, null, 2)}
                          </pre>
                        </details>
                      </div>
                    </AdminDetailDialog>
                  </div>
                </div>
              );
            })}
          </div>

          <AdminPagination
            readable
            total={auditResult.data.total}
            visible={auditResult.data.items.length}
            pageIndex={trail.length}
            pageSize={ADMIN_PAGE_SIZE}
            firstHref={auditPageHref(basePath, query, '', [])}
            previousHref={
              previousToken === null
                ? null
                : auditPageHref(basePath, query, previousToken, trail.slice(0, -1))
            }
            nextHref={
              auditResult.data.hasMore && auditResult.data.nextCursor
                ? auditPageHref(
                    basePath,
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
