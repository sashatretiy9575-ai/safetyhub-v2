import { Container } from '@/components/ui/container';

/**
 * This root boundary is outside each physical public/private locale layout.
 * It must not use next-intl hooks: doing so would make static prerendering
 * depend on a provider that has not mounted yet.
 */
export default function Loading() {
  return (
    <Container size="content" className="py-16">
      <div
        className="space-y-4 rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-soft)]"
        role="status"
        aria-live="polite"
        aria-label="Loading"
      >
        <div className="space-y-2">
          <div className="h-5 w-32 rounded-full bg-[var(--color-surface-muted)]" />
          <div className="h-10 w-3/4 rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-4 w-1/2 rounded-full bg-[var(--color-surface-muted)]" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="h-32 rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-32 rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-32 rounded-2xl bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    </Container>
  );
}
