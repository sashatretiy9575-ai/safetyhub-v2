'use client';

import Link from 'next/link';
import type { AdminAttestationRow } from '@/features/admin/types';
import { formatDateTime } from '@/lib/utils';
import {
  AttestationRowActions,
  AttestationWorkflowBadge,
  type AttestationPendingAction,
  type AttestationPermissions,
} from './attestations-manager-panels';

type AttestationTableRowProps = {
  row: AdminAttestationRow;
  selected: boolean;
  onSelectChange: (checked: boolean) => void;
  onOpenDetails: () => void;
  permissions: AttestationPermissions;
  onSingleAction: (action: AttestationPendingAction) => void;
  organizationHref: (organization: string) => string;
  /** True while the list is ordered by company, so the company name is already
   *  printed once in the band above and repeating it on every line is noise. */
  grouped: boolean;
};

/** Vertical rule between desktop cells; a spreadsheet reads by columns. */
const CELL = '@min-[760px]:border-l @min-[760px]:border-[var(--color-border)] @min-[760px]:pl-2';

/** A spreadsheet column needs one short line, not "8 авг. 2026 г., 14:51". */
function compactDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AttestationTableRow({
  row,
  selected,
  onSelectChange,
  onOpenDetails,
  permissions,
  onSingleAction,
  organizationHref,
  grouped,
}: AttestationTableRowProps) {
  const completed = formatDateTime(row.completedAt);

  return (
    <article
      role="row"
      // Phone: two lines per person instead of four — name/score/actions, then
      // course · date · status. The company is deliberately absent, the band
      // above already names it, and a four-line card made fifty rows a marathon.
      className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2 gap-y-0.5 rounded-xl border bg-[var(--color-surface)] px-2 py-1.5 text-sm shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-surface-muted)]/60 @min-[760px]:min-h-9 @min-[760px]:grid-cols-[32px_minmax(0,1.25fr)_minmax(0,0.95fr)_minmax(0,1.25fr)_6.5rem_44px_minmax(0,0.9fr)_32px] @min-[760px]:items-center @min-[760px]:gap-x-2 @min-[760px]:rounded-none @min-[760px]:border-0 @min-[760px]:border-t @min-[760px]:p-0 @min-[760px]:px-1.5 @min-[760px]:text-[13px] @min-[760px]:shadow-none"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('button, input, a, [role="menuitem"]')) onOpenDetails();
      }}
    >
      {/* 1. Selection */}
      <div
        role="cell"
        className="col-start-1 row-start-1 @min-[760px]:col-start-1 @min-[760px]:row-start-1 @min-[760px]:grid @min-[760px]:place-items-center"
      >
        <label className="grid size-8 cursor-pointer place-items-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectChange(event.target.checked)}
            className="size-4.5 accent-[var(--color-primary)]"
          />
          <span className="sr-only">
            Выбрать: {row.fullName}, {row.courseTitle}
          </span>
        </label>
      </div>

      {/* 2. Employee */}
      <div
        role="cell"
        className="col-start-2 row-start-1 min-w-0 @min-[760px]:col-start-2 @min-[760px]:row-start-1"
      >
        <button
          type="button"
          onClick={onOpenDetails}
          aria-label={`Открыть сведения: ${row.fullName}`}
          className="block min-w-0 max-w-full truncate text-left font-semibold hover:underline"
          title={row.fullName}
        >
          {row.fullName}
        </button>
      </div>

      {/* 3. Desktop only. While the sheet is banded by company this column shows
             the position; otherwise it shows the company, matching its header.
             On a phone the company rides along on the second line instead. */}
      <div
        role="cell"
        className={`hidden min-w-0 text-xs @min-[760px]:col-start-3 @min-[760px]:row-start-1 @min-[760px]:block @min-[760px]:text-[13px] ${CELL}`}
      >
        {grouped ? (
          <span className="block truncate text-[var(--color-text-muted)]" title={row.job}>
            {row.job || '—'}
          </span>
        ) : row.organization ? (
          <Link
            href={organizationHref(row.organization)}
            className="block truncate font-medium text-[var(--color-primary)] hover:underline"
            title={`Фильтр по компании: ${row.organization}`}
          >
            {row.organization}
          </Link>
        ) : (
          <span className="text-[var(--color-text-subtle)]">—</span>
        )}
      </div>

      {/* 4. Course — `col-end` must be reset, otherwise the desktop start column
          is greater than the mobile end column and the browser swaps them, so
          the course lands back on top of the previous cell. */}
      <div
        role="cell"
        className={`col-start-2 col-end-4 row-start-2 min-w-0 @min-[760px]:col-start-4 @min-[760px]:col-end-auto @min-[760px]:row-start-1 ${CELL}`}
      >
        <p
          className="truncate text-xs @min-[760px]:text-[13px] @min-[760px]:font-normal"
          title={row.courseTitle}
        >
          {row.courseTitle}
        </p>
        <p className="truncate text-[11px] text-[var(--color-text-subtle)] @min-[760px]:hidden">
          {completed}
          {!grouped && row.organization ? ` · ${row.organization}` : ''}
        </p>
      </div>

      {/* 5. Completion date — its own column on the desktop sheet */}
      <div
        role="cell"
        className={`hidden whitespace-nowrap text-[var(--color-text-muted)] tabular-nums @min-[760px]:col-start-5 @min-[760px]:row-start-1 @min-[760px]:block ${CELL}`}
      >
        <time dateTime={row.completedAt}>{compactDateTime(row.completedAt)}</time>
      </div>

      {/* 6. Score */}
      <div
        role="cell"
        className={`col-start-3 row-start-1 flex items-center justify-end @min-[760px]:col-start-6 @min-[760px]:row-start-1 @min-[760px]:justify-start ${CELL}`}
      >
        <span className="font-bold tabular-nums @min-[760px]:font-semibold">
          {row.score}/{row.total}
        </span>
      </div>

      {/* 7. Status */}
      <div
        role="cell"
        className={`col-start-4 row-start-2 flex min-w-0 items-center justify-end @min-[760px]:col-start-7 @min-[760px]:row-start-1 @min-[760px]:justify-start ${CELL}`}
      >
        <AttestationWorkflowBadge row={row} />
      </div>

      {/* 8. Actions */}
      <div
        role="cell"
        className="col-start-4 row-start-1 flex justify-end @min-[760px]:col-start-8 @min-[760px]:row-start-1 @min-[760px]:justify-center"
      >
        <AttestationRowActions
          row={row}
          permissions={permissions}
          openDetails={onOpenDetails}
          openAction={onSingleAction}
        />
      </div>
    </article>
  );
}
