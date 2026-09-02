import Link from 'next/link';
import { Container } from '@/components/ui/container';
import { Button } from '@/components/ui/button';

/** Root 404 also sits outside the independent locale layouts. */
export default function NotFound() {
  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm tracking-widest text-[var(--color-text-muted)] uppercase">
          404
        </p>
        <h1 className="font-display text-3xl font-semibold">Page not found</h1>
        <p className="text-[var(--color-text-muted)]">The page you requested is unavailable.</p>
        <Button asChild>
          <Link href="/">Home</Link>
        </Button>
      </div>
    </Container>
  );
}
