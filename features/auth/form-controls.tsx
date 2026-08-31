'use client';

import { forwardRef, useState } from 'react';
import type { InputProps } from '@/components/ui/input';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-[var(--color-danger)]">
      {message}
    </p>
  );
}

export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  function PasswordInput({ className, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          {...props}
          type={visible ? 'text' : 'password'}
          className={cn('pr-14', className)}
        />
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 grid min-h-11 min-w-11 place-items-center rounded-r-[var(--radius-md)] px-2 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {visible ? 'Скрыть' : 'Показать'}
        </button>
      </div>
    );
  },
);
