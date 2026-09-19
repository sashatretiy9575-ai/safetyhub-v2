export function RouteLoading({ floating = false, label = 'Loading' }: { floating?: boolean; label?: string }) {
  return <div role="status" aria-label={label} data-navigation-loading={floating ? 'pending' : 'fallback'} style={{ backgroundColor: 'rgba(0, 0, 0, 0.35)', backdropFilter: 'blur(2px)' }} className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center">
    <span aria-hidden="true" style={{ width: 96, height: 96, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="rounded-3xl bg-[var(--color-surface)] shadow-xl ring-1 ring-white/15">
      <span className="block h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-primary)] border-r-transparent motion-reduce:animate-none" />
    </span>
    <span className="sr-only">{label}</span>
  </div>;
}
