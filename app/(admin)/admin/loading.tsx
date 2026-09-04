/**
 * Every admin screen is rendered per request, so a navigation waits on the
 * server before anything changes on screen. Without a boundary inside the admin
 * segment the nearest one is the root `app/loading.tsx`, which replaces the
 * whole shell — sidebar included — for the duration. This keeps the chrome in
 * place and only greys out the work area, so a click is acknowledged at once.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-label="Загружаем раздел">
      <div className="h-9 w-64 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
      <div className="h-14 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]" />
      <div className="h-12 animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
      <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        {[0, 1, 2, 3, 4, 5].map((row) => (
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
