'use client';

import type { SelectHTMLAttributes } from 'react';

/**
 * A `<select>` that submits its owning form on change.
 *
 * Admin list pages are Server Components, and a Server Component may not pass
 * an event handler to a DOM element — doing so throws at render time and the
 * whole section falls back to the admin error boundary. Keeping the handler in
 * this tiny client island preserves the one-tap filtering behaviour.
 */
export function AdminFilterSelect({
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      onChange={(event) => event.target.form?.requestSubmit()}
      className={`min-h-11 cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm ${className}`}
    />
  );
}
