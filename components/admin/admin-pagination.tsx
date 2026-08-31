import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function AdminPagination({
  total,
  visible,
  hasCursor,
  nextHref,
  firstHref,
}: {
  total: number;
  visible: number;
  hasCursor: boolean;
  nextHref: string | null;
  firstHref: string;
}) {
  return (
    <nav
      aria-label="Пагинация"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4"
    >
      <p className="text-sm text-[var(--color-text-muted)]">
        На странице: {visible}. Найдено: {total}.
      </p>
      <div className="flex flex-wrap gap-2">
        {hasCursor ? (
          <Button asChild size="sm" variant="outline">
            <Link href={firstHref} prefetch={false}>К началу</Link>
          </Button>
        ) : null}
        {nextHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={nextHref} prefetch={false}>Следующая страница</Link>
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
