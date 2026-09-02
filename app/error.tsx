'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { reportAppError } from '@/lib/observability';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  const diagnostic = reportAppError(error, { source: 'route-error' });

  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div
        className="mx-auto w-full max-w-xl space-y-5 rounded-3xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-6 shadow-[var(--shadow-soft)]"
        role="alert"
      >
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Please try again. If the problem continues, contact the SafetyHub team.
          </p>
          <p className="font-mono text-xs break-all text-[var(--color-text-subtle)]">
            Reference: {diagnostic.correlationId}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Home</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
