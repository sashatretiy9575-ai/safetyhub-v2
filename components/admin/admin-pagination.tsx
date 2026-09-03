import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function AdminPagination({
  total,
  visible,
  hasCursor,
  nextHref,
  firstHref,
  pageSize = 50,
}: {
  total: number;
  visible: number;
  hasCursor: boolean;
  nextHref: string | null;
  firstHref: string;
  pageSize?: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <nav
      aria-label="Пагинация"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4"
    >
      <p className="text-xs text-[var(--color-text-muted)]">
        На странице: <strong className="text-[var(--color-text)]">{visible}</strong>. Найдено: <strong className="text-[var(--color-text)]">{total}</strong>.
      </p>
      <div className="flex items-center gap-1.5">
        {hasCursor ? (
          <Button asChild size="sm" variant="outline" className="h-8 px-2 text-xs">
            <Link href={firstHref} prefetch={false}>« К началу</Link>
          </Button>
        ) : null}

        <div className="flex items-center gap-1">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-primary)] text-xs font-bold text-white">
            1
          </span>
          {totalPages > 1 ? (
            <span className="grid size-8 place-items-center rounded-lg border text-xs text-[var(--color-text-muted)]">
              2
            </span>
          ) : null}
          {totalPages > 2 ? (
            <span className="grid size-8 place-items-center rounded-lg border text-xs text-[var(--color-text-muted)]">
              3
            </span>
          ) : null}
          {totalPages > 4 ? (
            <span className="px-1 text-xs text-[var(--color-text-muted)]">...</span>
          ) : null}
          {totalPages > 3 ? (
            <span className="grid size-8 place-items-center rounded-lg border text-xs text-[var(--color-text-muted)]">
              {totalPages}
            </span>
          ) : null}
        </div>

        {nextHref ? (
          <Button asChild size="sm" variant="outline" className="h-8 px-2 text-xs">
            <Link href={nextHref} prefetch={false}>Следующая »</Link>
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
