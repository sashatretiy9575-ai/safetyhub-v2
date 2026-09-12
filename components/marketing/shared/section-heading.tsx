import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SectionHeadingProps = {
  id: string;
  eyebrow?: string;
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
        'flex flex-col items-start justify-between gap-5 lg:flex-row lg:items-end lg:gap-8',
        className,
      )}
    >
      <div className="max-w-3xl">
        {eyebrow ? (
          <p className="text-micro mb-2.5 inline-flex items-center gap-2 font-bold tracking-widest text-[var(--color-text-subtle)] uppercase sm:text-xs">
            <span
              aria-hidden="true"
              className="h-px w-5 rounded-full bg-[var(--color-primary)] sm:w-6"
            />
            {eyebrow}
          </p>
        ) : null}
        <h2 id={id} className="text-h2 max-w-2xl font-bold text-balance">
          {title}
        </h2>
        {description ? (
          <p className="text-body-sm mt-3 max-w-2xl text-[var(--color-text-muted)] lg:text-base">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
