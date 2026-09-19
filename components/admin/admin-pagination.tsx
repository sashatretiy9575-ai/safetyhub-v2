import Link from '@/components/shared/navigation-link';
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
  readable = false,
}: {
  total: number;
  visible: number;
  /** Zero-based index of the page currently rendered. */
  pageIndex: number;
  firstHref: string;
  previousHref: string | null;
  nextHref: string | null;
  pageSize?: number;
  readable?: boolean;
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
      <p className="text-sm text-[var(--color-text-muted)]">
        Показаны{' '}
        <strong className="text-[var(--color-text)] tabular-nums">
          {rangeStart}–{rangeEnd}
        </strong>{' '}
        из <strong className="text-[var(--color-text)] tabular-nums">{total}</strong>
      </p>

      <div
        className={
          readable
            ? 'flex min-w-0 flex-wrap items-center gap-2 [&_a]:text-base [&_span]:text-base'
            : 'flex min-w-0 flex-wrap items-center gap-1.5'
        }
      >
        {pageIndex > 0 ? (
          <Button asChild size="sm" variant="ghost" className="min-h-11 px-3 text-sm">
            <Link href={firstHref} prefetch={false}>
              В начало
            </Link>
          </Button>
        ) : null}

        {previousHref ? (
          <Button asChild size="sm" variant="outline" className="min-h-11 gap-1 px-3 text-sm">
            <Link href={previousHref} prefetch={false} rel="prev">
              <CaretLeft aria-hidden size={15} weight="bold" />
              Назад
            </Link>
          </Button>
        ) : (
          <span className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text-subtle)]">
            <CaretLeft aria-hidden size={15} weight="bold" />
            Назад
          </span>
        )}

        <span className="px-2 text-sm font-semibold tabular-nums" aria-current="page">
          {currentPage} / {totalPages}
        </span>

        {nextHref ? (
          <Button asChild size="sm" variant="outline" className="min-h-11 gap-1 px-3 text-sm">
            <Link href={nextHref} prefetch={false} rel="next">
              {readable ? 'Далее' : 'Вперёд'}
              <CaretRight aria-hidden size={15} weight="bold" />
            </Link>
          </Button>
        ) : (
          <span className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text-subtle)]">
            {readable ? 'Далее' : 'Вперёд'}
            <CaretRight aria-hidden size={15} weight="bold" />
          </span>
        )}
      </div>
    </nav>
  );
}
