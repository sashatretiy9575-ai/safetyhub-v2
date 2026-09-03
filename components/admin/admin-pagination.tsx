import Link from 'next/link';
import { CaretLeft, CaretRight } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';

/**
 * The previous version printed the numbers 1, 2, 3 … as inert `<span>`s and
 * offered only "Следующая »", so a list could be walked forward but never back
 * and the highlighted page was always "1". It also assumed a page size of 50
 * while the RPCs return 25, which made the page count roughly twice too small.
 */
export function AdminPagination({
  total,
  visible,
  pageIndex,
  firstHref,
  previousHref,
  nextHref,
  pageSize = 25,
}: {
  total: number;
  visible: number;
  /** Zero-based index of the page currently rendered. */
  pageIndex: number;
  firstHref: string;
  previousHref: string | null;
  nextHref: string | null;
  pageSize?: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const currentPage = Math.min(pageIndex + 1, totalPages);
  const rangeStart = total === 0 ? 0 : pageIndex * pageSize + 1;
  const rangeEnd = pageIndex * pageSize + visible;

  return (
    <nav
      aria-label="Постраничная навигация"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4"
    >
      <p className="text-xs text-[var(--color-text-muted)]">
        Показаны{' '}
        <strong className="text-[var(--color-text)] tabular-nums">
          {rangeStart}–{rangeEnd}
        </strong>{' '}
        из <strong className="text-[var(--color-text)] tabular-nums">{total}</strong>
      </p>

      <div className="flex items-center gap-1.5">
        {pageIndex > 0 ? (
          <Button asChild size="sm" variant="ghost" className="h-8 px-2 text-xs">
            <Link href={firstHref} prefetch={false}>
              В начало
            </Link>
          </Button>
        ) : null}

        {previousHref ? (
          <Button asChild size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs">
            <Link href={previousHref} prefetch={false} rel="prev">
              <CaretLeft aria-hidden size={13} weight="bold" />
              Назад
            </Link>
          </Button>
        ) : (
          <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-subtle)]">
            <CaretLeft aria-hidden size={13} weight="bold" />
            Назад
          </span>
        )}

        <span className="px-1.5 text-xs font-semibold tabular-nums" aria-current="page">
          {currentPage} / {totalPages}
        </span>

        {nextHref ? (
          <Button asChild size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs">
            <Link href={nextHref} prefetch={false} rel="next">
              Вперёд
              <CaretRight aria-hidden size={13} weight="bold" />
            </Link>
          </Button>
        ) : (
          <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-subtle)]">
            Вперёд
            <CaretRight aria-hidden size={13} weight="bold" />
          </span>
        )}
      </div>
    </nav>
  );
}
