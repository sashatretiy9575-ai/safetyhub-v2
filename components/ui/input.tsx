import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', invalid, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-base text-[var(--color-text)] shadow-[var(--shadow-soft)] transition placeholder:text-[var(--color-text-subtle)] sm:text-sm',
        'focus-visible:border-[var(--color-primary)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid && 'border-[var(--color-danger)] focus-visible:border-[var(--color-danger)]',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
