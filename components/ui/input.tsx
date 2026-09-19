import * as React from 'react';
import { fieldBase, fieldFocus, fieldInvalid } from '@/components/ui/field';
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
      className={cn('flex h-11 px-4 py-2', fieldBase, fieldFocus, invalid && fieldInvalid, className)}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
