import Link from 'next/link';
import { Container } from '@/components/ui/container';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm uppercase tracking-widest text-[var(--color-text-muted)]">404</p>
        <h1 className="font-display text-3xl font-semibold">Страница не найдена</h1>
        <p className="text-[var(--color-text-muted)]">Возможно, ссылка устарела или была перемещена.</p>
        <Button asChild>
          <Link href="/">На главную</Link>
        </Button>
      </div>
    </Container>
  );
}
