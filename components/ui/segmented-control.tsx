'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /**
   * The icon says it all: the label stays for screen readers, and with
   * 'compact' comes back where there is room for it.
   */
  labelHidden?: boolean | 'compact';
};

/**
 * One choice out of two or three that are all visible at once: a switch, not
 * a row of buttons. A radio group underneath, so arrows move the choice and
 * Tab passes the whole control in one step.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  // The choice is typed by `value`; the options and the handler follow it.
  options: readonly SegmentedOption<NoInfer<T>>[];
  onChange(value: NoInfer<T>): void;
  className?: string;
}) {
  const group = React.useRef<HTMLDivElement>(null);
  function move(event: React.KeyboardEvent, index: number) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : step
            ? (index + step + options.length) % options.length
            : -1;
    if (target < 0) return;
    event.preventDefault();
    onChange(options[target]!.value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus();
  }
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={cn(
        // The track is the 44 px touch target; a segment fills all but its rim.
        'grid min-w-0 auto-cols-fr grid-flow-col gap-0.5 rounded-[var(--radius-control)] bg-[var(--color-surface-soft)] p-0.5',
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            title={option.labelHidden ? option.label : undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-2 text-sm font-semibold transition-colors sm:px-3 [&_svg]:size-4 [&_svg]:shrink-0',
              checked
                ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow-[var(--shadow-soft)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
            )}
          >
            {option.icon}
            <span
              className={cn(
                'min-w-0 truncate',
                option.labelHidden === 'compact' && 'sr-only sm:not-sr-only',
                option.labelHidden === true && 'sr-only',
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
