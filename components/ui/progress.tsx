'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type ProgressProps = Omit<React.ComponentPropsWithoutRef<'progress'>, 'value' | 'max'> & {
  value?: number;
  max?: number;
};

export const Progress = React.forwardRef<HTMLProgressElement, ProgressProps>(
  ({ className, value = 0, max = 100, ...props }, ref) => {
    const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
    const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;

    return (
      <progress
        ref={ref}
        value={safeValue}
        max={safeMax}
        className={cn(
          'h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-[var(--color-surface-muted)]',
          '[&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-[var(--color-surface-muted)]',
          '[&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-[var(--color-primary)]',
          '[&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-[var(--color-primary)]',
          className,
        )}
        {...props}
      />
    );
  },
);
Progress.displayName = 'Progress';
