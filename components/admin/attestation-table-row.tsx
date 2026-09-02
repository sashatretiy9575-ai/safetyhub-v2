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
};

export function AttestationTableRow({
  row,
  selected,
  onSelectChange,
  onOpenDetails,
  permissions,
  onSingleAction,
  organizationHref,
}: AttestationTableRowProps) {
  return (
    <article
      role="row"
      className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-xl border bg-[var(--color-surface)] p-3 text-sm shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-surface-muted)]/60 @min-[960px]:min-h-[56px] @min-[960px]:grid-cols-[40px_minmax(0,1.4fr)_minmax(0,1.4fr)_64px_minmax(0,0.8fr)_40px] @min-[960px]:items-center @min-[960px]:gap-x-3 @min-[960px]:rounded-none @min-[960px]:border-0 @min-[960px]:border-t @min-[960px]:p-2.5 @min-[960px]:shadow-none"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('button, input, a, [role="menuitem"]')) onOpenDetails();
      }}
    >
      {/* 1. Selection Checkbox */}
      <div
        role="cell"
        className="col-start-1 row-start-1 @min-[960px]:col-start-1 @min-[960px]:row-start-1 @min-[960px]:grid @min-[960px]:place-items-center"
      >
        <label className="grid size-10 cursor-pointer place-items-center">
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

      {/* 2. Employee (Name + Company underneath) */}
      <div
        role="cell"
        className="col-start-2 row-start-1 min-w-0 @min-[960px]:col-start-2 @min-[960px]:row-start-1"
      >
        <button
          type="button"
          onClick={onOpenDetails}
          aria-label={`Открыть сведения: ${row.fullName}`}
          className="block min-w-0 text-left hover:underline"
        >
          <span className="block font-semibold break-words leading-tight">{row.fullName}</span>
        </button>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)] truncate">
          {row.organization ? (
            <Link
              href={organizationHref(row.organization)}
              className="hover:underline text-[var(--color-primary)]"
              title={`Фильтр по компании: ${row.organization}`}
            >
              {row.organization}
            </Link>
          ) : (
            <span className="text-[var(--color-text-subtle)]">—</span>
          )}
        </div>
      </div>

      {/* 3. Course (Title + Date underneath) */}
      <div
        role="cell"
        className="col-start-1 col-end-3 row-start-2 min-w-0 border-t pt-1.5 @min-[960px]:col-start-3 @min-[960px]:col-end-4 @min-[960px]:row-start-1 @min-[960px]:border-0 @min-[960px]:pt-0"
      >
        <p className="font-medium break-words leading-tight">{row.courseTitle}</p>
        <p className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">
          {formatDateTime(row.completedAt)}
        </p>
      </div>

      {/* 4. Score */}
      <div
        role="cell"
        className="col-start-3 row-start-2 flex items-center justify-end border-t pt-1.5 @min-[960px]:col-start-4 @min-[960px]:row-start-1 @min-[960px]:border-0 @min-[960px]:pt-0 @min-[960px]:justify-start"
      >
        <span className="text-sm font-black tabular-nums">
          {row.score}/{row.total}
        </span>
      </div>

      {/* 5. Status Badge */}
      <div
        role="cell"
        className="col-start-2 row-start-3 flex items-center @min-[960px]:col-start-5 @min-[960px]:row-start-1"
      >
        <AttestationWorkflowBadge row={row} />
      </div>

      {/* 6. Actions Menu */}
      <div
        role="cell"
        className="col-start-3 row-start-1 flex justify-end @min-[960px]:col-start-6 @min-[960px]:row-start-1 @min-[960px]:justify-center"
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
