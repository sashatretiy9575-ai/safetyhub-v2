'use client';

import Link from 'next/link';
import type { AdminAttestationRow } from '@/lib/admin/types';
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
const CELL =
  'min-w-0 @min-[760px]:border-l @min-[760px]:border-[var(--color-border)] @min-[760px]:pl-2';

/**
 * A spreadsheet column needs one short line, not "8 авг. 2026 г., 14:51".
 *
 * `timeZone` must be pinned: this is a Client Component, so its first render
 * happens twice — once during SSR on the server (whatever OS timezone that
 * process runs in) and once during hydration in the browser (the visitor's
 * own timezone). Without a fixed zone the two renders produce different text
 * for the same instant whenever they differ, which React reports as a
 * hydration mismatch and forces a client-side re-render of the whole tree.
 */
// One formatter for the whole table rather than one per cell per render. The
// time zone is fixed on purpose: see the note above about hydration.
const COMPACT_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Oral',
});

function compactDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return COMPACT_DATE_TIME.format(date);
}

/** One step smaller on a phone, so the course beside it keeps its words. */
const STATUS_BADGE =
  'text-micro min-h-6 px-2 py-0.5 @min-[760px]:text-caption @min-[760px]:min-h-7 @min-[760px]:px-3 @min-[760px]:py-1';

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
  return (
    <article
      role="row"
      // Two layouts, one markup.
      //   A phone gets two lines between the checkbox and the actions button,
      //   which stand at the card's edges at its full height: the name and the
      //   score, then the course and the status. The lines are one wrapping
      //   flex row, so a long status takes room from the course beside it and
      //   never from the name above it; when the course would lose its words
      //   altogether, the status moves under it.
      //   From 47.5rem it is the spreadsheet, one line per person. Below
      //   57.5rem (a 1024 px laptop with the sidebar) the sheet leaves out the
      //   position column and the time, so names and course titles stay whole.
      className="@min-[760px]:text-caption relative flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-[var(--color-border)]/55 bg-[var(--color-surface)] py-2.5 pr-10 pl-10 text-sm shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-surface-muted)]/60 @min-[760px]:grid @min-[760px]:min-h-11 @min-[760px]:grid-cols-[32px_minmax(0,1.2fr)_minmax(0,1.2fr)_4.75rem_44px_minmax(10.75rem,1fr)_44px] @min-[920px]:grid-cols-[32px_minmax(0,1.25fr)_minmax(0,0.95fr)_minmax(0,1.25fr)_6.5rem_44px_minmax(10.75rem,1fr)_44px] @min-[760px]:gap-x-2 @min-[760px]:gap-y-0 @min-[760px]:rounded-none @min-[760px]:border-0 @min-[760px]:border-t @min-[760px]:border-[var(--color-border)]/55 @min-[760px]:p-0 @min-[760px]:px-1.5 @min-[760px]:shadow-none"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        // `label` too: a tap on the checkbox's padding used to tick the box and
        // open the card at the same time.
        if (!target.closest('button, input, a, label, [role="menuitem"]')) onOpenDetails();
      }}
    >
      {/* 1. Selection — the card's left edge, centred on its full height */}
      <div
        role="cell"
        className="absolute inset-y-0 left-0 grid w-10 place-items-center @min-[760px]:static @min-[760px]:col-start-1 @min-[760px]:row-start-1 @min-[760px]:w-auto"
      >
        <label className="grid h-11 w-10 cursor-pointer place-items-center @min-[760px]:size-8">
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
        className="order-1 min-w-0 grow basis-24 @min-[760px]:col-start-2 @min-[760px]:row-start-1"
      >
        <button
          type="button"
          onClick={onOpenDetails}
          aria-label={`Открыть сведения: ${row.fullName}`}
          className="block max-w-full min-w-0 truncate text-left font-semibold hover:underline"
          title={row.fullName}
        >
          {row.fullName}
        </button>
      </div>

      {/* 3. The full sheet only. While the sheet is banded by company this column
             shows the position; otherwise it shows the company, matching its
             header. On a phone and on the narrow sheet the company rides along
             after the course instead. */}
      <div
        role="cell"
        className={`@min-[760px]:text-caption hidden min-w-0 text-xs @min-[760px]:row-start-1 @min-[920px]:col-start-3 @min-[920px]:block ${CELL}`}
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

      {/* 4. Course, with the date beside it once a phone has the room */}
      <div
        role="cell"
        className={`order-4 flex min-w-0 grow basis-16 items-baseline gap-1.5 @min-[760px]:col-start-3 @min-[760px]:row-start-1 @min-[760px]:block @min-[920px]:col-start-4 ${CELL}`}
      >
        <p
          className="@min-[760px]:text-caption truncate text-xs text-[var(--color-text-muted)] @min-[760px]:text-[var(--color-text)]"
          title={row.courseTitle}
        >
          {row.courseTitle}
          {!grouped && row.organization ? (
            <span className="@min-[920px]:hidden"> · {row.organization}</span>
          ) : null}
        </p>
        <time
          dateTime={row.completedAt}
          className="text-micro hidden shrink-0 text-[var(--color-text-subtle)] tabular-nums @min-[480px]:inline @min-[760px]:hidden"
        >
          {compactDateTime(row.completedAt)}
        </time>
      </div>

      {/* 5. Completion date — its own column on the desktop sheet */}
      <div
        role="cell"
        className={`hidden whitespace-nowrap text-[var(--color-text-muted)] tabular-nums @min-[760px]:col-start-4 @min-[760px]:row-start-1 @min-[760px]:block @min-[920px]:col-start-5 ${CELL}`}
      >
        {/* The narrow sheet keeps the day and drops the time; the card and a
            wider sheet show both. */}
        <time dateTime={row.completedAt}>
          {compactDateTime(row.completedAt).split(', ')[0]}
          <span className="hidden @min-[920px]:inline">
            , {compactDateTime(row.completedAt).split(', ')[1] ?? ''}
          </span>
        </time>
      </div>

      {/* 6. Score */}
      <div
        role="cell"
        className={`order-2 flex shrink-0 items-center justify-end @min-[760px]:col-start-5 @min-[760px]:row-start-1 @min-[760px]:justify-start @min-[920px]:col-start-6 ${CELL}`}
      >
        <span className="font-bold tabular-nums @min-[760px]:font-semibold">
          {row.score}/{row.total}
        </span>
      </div>

      {/* Phone only: closes the first line, so the course opens the second. */}
      <div aria-hidden="true" className="order-3 basis-full @min-[760px]:hidden" />

      {/* 7. Status */}
      <div
        role="cell"
        className={`order-5 flex shrink-0 items-center justify-end @min-[760px]:col-start-6 @min-[760px]:row-start-1 @min-[760px]:justify-start @min-[920px]:col-start-7 ${CELL}`}
      >
        <AttestationWorkflowBadge row={row} className={STATUS_BADGE} />
      </div>

      {/* 8. Actions — the card's right edge, centred on its full height */}
      <div
        role="cell"
        className="absolute inset-y-0 right-0 grid w-10 place-items-center @min-[760px]:static @min-[760px]:col-start-7 @min-[760px]:row-start-1 @min-[760px]:w-auto @min-[920px]:col-start-8"
      >
        <AttestationRowActions
          row={row}
          permissions={permissions}
          openAction={onSingleAction}
        />
      </div>
    </article>
  );
}
