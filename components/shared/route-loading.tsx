export function RouteLoading({ floating = false, label = 'Loading' }: { floating?: boolean; label?: string }) {
  return <div role="status" aria-label={label} className={floating ? 'pointer-events-none fixed left-1/2 top-24 z-[100] -translate-x-1/2' : 'flex justify-center py-12'}>
    <span aria-hidden="true" className="block h-[clamp(48px,20vw,80px)] w-[clamp(48px,20vw,80px)] animate-spin rounded-full border-4 border-[var(--color-primary)] border-r-transparent bg-transparent motion-reduce:animate-none md:h-12 md:w-12" />
    <span className="sr-only">{label}</span>
  </div>;
}
