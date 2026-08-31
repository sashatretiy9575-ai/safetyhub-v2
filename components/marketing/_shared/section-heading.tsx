import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SectionHeadingProps = {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function SectionHeading({
  id,
  eyebrow,
  title,
  description,
  action,
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start justify-between gap-5 min-[900px]:flex-row min-[900px]:items-end min-[900px]:gap-8',
        className,
      )}
    >
      <div className="max-w-3xl">
        <p className="inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-[var(--color-text-subtle)] uppercase sm:text-xs">
          <span
            aria-hidden="true"
            className="h-px w-5 rounded-full bg-[var(--color-primary)] sm:w-6"
          />
          {eyebrow}
        </p>
        <h2
          id={id}
          className="mt-2.5 max-w-2xl text-[24px] leading-[1.2] font-bold tracking-[-0.03em] text-balance sm:text-[30px] sm:leading-[1.18] lg:text-[38px]"
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-3 max-w-2xl text-[14px] leading-[1.6] text-[var(--color-text-muted)] sm:text-[15px] sm:leading-6 lg:text-base">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
