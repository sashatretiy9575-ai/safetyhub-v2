import type { ReactNode } from 'react';
import Link from 'next/link';
import { PencilSimple } from '@phosphor-icons/react/dist/ssr/PencilSimple';
import { Button } from '@/components/ui/button';
import { BUSINESS_TIME_ZONE } from '@/i18n/config';

/**
 * The list of «Курсы» and of «Материалы»: one header, one sheet, one row.
 * Nothing here needs the browser, so the pages render it on the server.
 */

// One template for the heading line and for every row. The last column is as
// wide as the actions, which are given a fixed width so the columns line up.
const SHEET_COLUMNS =
  'md:grid md:grid-cols-[minmax(0,2fr)_11rem_8rem_auto] md:items-center md:gap-3 md:px-4';

// The zone is pinned: the server's own clock zone is not the operator's.
const UPDATED_DATE = new Intl.DateTimeFormat('ru-RU', { timeZone: BUSINESS_TIME_ZONE });
const UPDATED_TIME = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: BUSINESS_TIME_ZONE,
});

/**
 * The page's own heading goes in as `children`. «Сбросить» exists only while a
 * filter is applied, yet its place is always taken: the search panel below
 * must not move at the moment the filter it has just sent is applied. Like a
 * search, a reset replaces the history entry: the browser's Back leaves the
 * list instead of replaying its filters one by one.
 */
export function AdminListHeader({
  count,
  resetHref,
  action,
  children,
}: {
  count: number;
  /** Where «Сбросить» leads; `null` while no filter is applied. */
  resetHref: string | null;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {children}
      <span className="rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-xs font-bold text-[var(--color-text-muted)] tabular-nums">
        {count}
      </span>
      {resetHref ? (
        <Button asChild size="sm" variant="ghost" className="px-2">
          <Link href={resetHref} replace>
            Сбросить
          </Link>
        </Button>
      ) : (
        <Button asChild size="sm" variant="ghost" className="invisible px-2">
          <span aria-hidden="true">Сбросить</span>
        </Button>
      )}
      <div className="ml-auto">{action}</div>
    </div>
  );
}

export function AdminListSheet({
  nameLabel,
  children,
}: {
  nameLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-group)] border bg-[var(--color-surface)]">
      <div
        aria-hidden="true"
        className={`hidden min-h-11 border-b bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-muted)] ${SHEET_COLUMNS}`}
      >
        <span>{nameLabel}</span>
        <span>Статус</span>
        <span>Изменено</span>
        <span className="w-24 text-right">Действия</span>
      </div>
      {/* The rows have a parent of their own, so the first one draws no line above itself. */}
      <div>{children}</div>
    </div>
  );
}

function Updated({ value, withTime = false }: { value: string; withTime?: boolean }) {
  const date = new Date(value);
  return (
    <time dateTime={value}>
      <span className="sr-only">Изменено </span>
      {UPDATED_DATE.format(date)}
      {withTime ? (
        <span className="ml-1.5 text-[var(--color-text-subtle)]">{UPDATED_TIME.format(date)}</span>
      ) : null}
    </time>
  );
}

/**
 * On a phone the name owns the first line in full and wraps instead of being
 * cut; the second line carries the status and the date on the left and the
 * actions on the right, and the actions move under them when even that does
 * not fit (240 px). From `md` up the same four children fall into the sheet's
 * columns in their DOM order.
 */
export function AdminListRow({
  title,
  href,
  slug,
  badges,
  updatedAt,
  actions,
}: {
  title: string;
  /** The editor: both the name and the pencil lead there. */
  href: string;
  slug: string;
  badges: ReactNode;
  updatedAt: string;
  /** What follows the pencil. */
  actions: ReactNode;
}) {
  return (
    <article
      className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t px-3 py-2.5 first:border-t-0 md:min-h-16 ${SHEET_COLUMNS}`}
    >
      <div className="min-w-0 basis-full">
        <h2 className="font-semibold [overflow-wrap:anywhere] break-words">
          <Link href={href} className="hover:text-[var(--color-primary)] hover:underline">
            {title}
          </Link>
        </h2>
        <p className="truncate text-xs text-[var(--color-text-muted)]">/{slug}</p>
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {badges}
        <span className="text-xs text-[var(--color-text-muted)] tabular-nums md:hidden">
          <Updated value={updatedAt} />
        </span>
      </div>
      <div className="hidden text-xs text-[var(--color-text-muted)] tabular-nums md:block">
        <Updated value={updatedAt} withTime />
      </div>
      <div className="ml-auto flex w-24 shrink-0 items-center justify-end gap-1.5">
        <Button asChild size="icon" variant="outline">
          <Link href={href} aria-label={`Редактировать: ${title}`} title="Редактировать">
            <PencilSimple aria-hidden />
          </Link>
        </Button>
        {actions}
      </div>
    </article>
  );
}

export function AdminListEmpty() {
  return (
    <p className="p-8 text-center text-sm text-[var(--color-text-muted)]">Ничего не найдено</p>
  );
}
