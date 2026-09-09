import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A plain <label>.
 *
 * This used to wrap @radix-ui/react-label, whose only addition over the native
 * element is forwarding a click to the labelled control — which the browser
 * does on its own. The dependency also forced 'use client' on every page that
 * renders a form label.
 */
export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none text-[var(--color-text)] peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
