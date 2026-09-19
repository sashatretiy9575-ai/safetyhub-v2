import * as React from 'react';
import { fieldBase, fieldFocus, fieldInvalid } from '@/components/ui/field';
import { cn } from '@/lib/utils';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

/** The native control, so a phone opens its own picker; it only shares the field's frame. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, ...props }, ref) => (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-11 min-w-0 cursor-pointer px-3',
        fieldBase,
        fieldFocus,
        invalid && fieldInvalid,
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';
