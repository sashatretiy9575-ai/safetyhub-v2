import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
        primary: 'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]',
        success: 'bg-[var(--color-primary-soft)] text-[var(--color-success)]',
        warning: 'bg-[var(--color-accent-amber-soft)] text-[var(--color-warning)]',
        danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
        outline: 'border border-[var(--color-border)] text-[var(--color-text)]',
        sapphire: 'bg-[var(--color-accent-sapphire-soft)] text-[var(--color-accent-sapphire)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
