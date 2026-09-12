/**
 * Placeholders for the admin lists while the server renders them. Each mirrors
 * the shape of the screen it stands in for — title, the filter strip, the
 * rows — so nothing jumps when the real content arrives.
 */
export function AdminListSkeleton({
  label,
  rows = 8,
  filters = true,
  summary = false,
}: {
  label: string;
  rows?: number;
  filters?: boolean;
  summary?: boolean;
}) {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="h-9 w-56 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
        <div className="h-9 w-40 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
      </div>
      {summary ? (
        <div className="grid gap-px overflow-hidden rounded-[var(--radius-group)] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
          <div className="h-20 animate-pulse bg-[var(--color-surface)]" />
          <div className="h-20 animate-pulse bg-[var(--color-surface)]" />
        </div>
      ) : null}
      {filters ? (
        <div className="flex flex-wrap gap-2">
          <div className="h-11 min-w-0 flex-1 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
          <div className="h-11 w-24 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
          <div className="h-11 w-24 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
        </div>
      ) : null}
      <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className="h-10 animate-pulse rounded-lg bg-[var(--color-surface-muted)]"
            style={{ animationDelay: `${row * 60}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
