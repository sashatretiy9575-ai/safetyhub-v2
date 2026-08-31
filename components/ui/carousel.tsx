'use client';

import {
  Children,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type CarouselProps = {
  label: string;
  children: ReactNode;
  className?: string;
  gridClassName?: string;
  itemClassName?: string;
  itemLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  variant?: 'standard' | 'marketing';
};

export function Carousel({
  label,
  children,
  className,
  gridClassName = 'md:grid-cols-3',
  itemClassName,
  itemLabel = 'Карточка',
  previousLabel = 'Предыдущая карточка',
  nextLabel = 'Следующая карточка',
  variant = 'standard',
}: CarouselProps) {
  const items = Children.toArray(children);
  const trackRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [active, setActive] = useState(0);

  const goTo = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(items.length - 1, index));
      const track = trackRef.current;
      const item = track?.children.item(next) as HTMLElement | null;
      if (!track || !item) return;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      track.scrollTo({
        left: item.offsetLeft - track.offsetLeft,
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
      setActive(next);
    },
    [items.length],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const updateActive = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const track = trackRef.current;
      if (!track) return;
      const left = track.getBoundingClientRect().left;
      const distances = Array.from(track.children).map((item) =>
        Math.abs(item.getBoundingClientRect().left - left),
      );
      const closest = distances.indexOf(Math.min(...distances));
      if (closest >= 0) setActive(closest);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(active + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(active - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      goTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      goTo(items.length - 1);
    }
  };

  if (items.length === 0) return null;

  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      className={cn('min-w-0', className)}
    >
      {variant === 'marketing' ? (
        <p className="sr-only" aria-live="polite">
          {itemLabel} {active + 1} из {items.length}
        </p>
      ) : null}
      {variant === 'standard' && items.length > 1 ? (
        <div className="mb-3 flex items-center justify-between gap-3 md:hidden">
          <p className="text-sm font-medium text-[var(--color-text-muted)]" aria-live="polite">
            {itemLabel} {active + 1} из {items.length}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={previousLabel}
              disabled={active === 0}
              onClick={() => goTo(active - 1)}
            >
              <CaretLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={nextLabel}
              disabled={active === items.length - 1}
              onClick={() => goTo(active + 1)}
            >
              <CaretRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
      <div
        ref={trackRef}
        role="list"
        tabIndex={items.length > 1 ? 0 : undefined}
        onKeyDown={handleKeyDown}
        onScroll={updateActive}
        className={cn(
          variant === 'marketing'
            ? 'flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 pr-[14%] [scrollbar-width:none] focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)] [&::-webkit-scrollbar]:hidden sm:gap-4 sm:pr-[12%] min-[1200px]:grid min-[1200px]:grid-cols-3 min-[1200px]:gap-5 min-[1200px]:overflow-visible min-[1200px]:pr-0'
            : 'flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3 focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)] md:grid md:gap-5 md:overflow-visible md:pb-0',
          variant === 'standard' ? gridClassName : undefined,
        )}
      >
        {items.map((item, index) => (
          <div
            key={index}
            role="listitem"
            aria-roledescription="slide"
            aria-label={`${itemLabel} ${index + 1} из ${items.length}`}
            className={cn(
              variant === 'marketing'
                ? 'h-auto min-w-[min(82vw,19.5rem)] snap-start sm:min-w-[calc((100%_-_1rem)/2.15)] min-[1200px]:min-w-0'
                : 'min-w-[92%] snap-start min-[420px]:min-w-[76%] md:min-w-0',
              itemClassName,
            )}
          >
            {item}
          </div>
        ))}
      </div>
      {variant === 'marketing' && items.length > 1 ? (
        <div
          data-marketing-carousel-controls
          className="mt-3 flex items-center justify-between gap-3 min-[1200px]:hidden"
        >
          <div aria-hidden="true" className="flex min-w-0 max-w-36 flex-1 gap-1.5">
            {items.map((_, index) => (
              <span
                key={index}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  index === active ? 'bg-[var(--color-text)]' : 'bg-[var(--color-border-strong)]',
                )}
              />
            ))}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => goTo(active - 1)}
              disabled={active === 0}
              aria-label={previousLabel}
              className="grid size-11 place-items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)]/90 text-[var(--color-text)] shadow-sm backdrop-blur-xl transition hover:bg-[var(--color-surface)] disabled:pointer-events-none disabled:opacity-40"
            >
              <CaretLeft size={20} weight="regular" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => goTo(active + 1)}
              disabled={active === items.length - 1}
              aria-label={nextLabel}
              className="grid size-11 place-items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)]/90 text-[var(--color-text)] shadow-sm backdrop-blur-xl transition hover:bg-[var(--color-surface)] disabled:pointer-events-none disabled:opacity-40"
            >
              <CaretRight size={20} weight="regular" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
