import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[color,background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-[var(--color-focus)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow-[var(--shadow-soft)] hover:bg-[var(--color-primary-hover)] active:translate-y-px',
        secondary:
          'border border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-text)] shadow-[var(--shadow-soft)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]',
        outline:
          'border border-[var(--color-border-strong)] bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]',
        ghost: 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]',
        uppercase:
          'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] hover:bg-[var(--color-primary-hover)] uppercase tracking-wider text-xs font-bold',
        danger:
          'bg-[var(--color-danger)] text-[var(--color-danger-foreground)] hover:brightness-90',
        link: 'text-[var(--color-primary)] underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        sm: 'h-11 rounded-[var(--radius-control)] px-4 text-sm',
        md: 'h-11 rounded-[var(--radius-control)] px-6 text-sm',
        lg: 'h-12 rounded-[var(--radius-control)] px-7 text-base',
        xl: 'h-14 rounded-[var(--radius-control)] px-9 text-base',
        icon: 'size-11 rounded-[var(--radius-control)]',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
