import * as React from 'react';
import { fieldBase, fieldFocus, fieldInvalid } from '@/components/ui/field';
import { cn } from '@/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, rows = 4, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn('flex px-4 py-3', fieldBase, fieldFocus, invalid && fieldInvalid, className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
