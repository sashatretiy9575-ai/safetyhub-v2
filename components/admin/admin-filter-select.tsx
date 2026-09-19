'use client';

import { Select, type SelectProps } from '@/components/ui/select';

/**
 * A `<select>` that submits its owning form on change.
 *
 * Admin list pages are Server Components, and a Server Component may not pass
 * an event handler to a DOM element — doing so throws at render time and the
 * whole section falls back to the admin error boundary. Keeping the handler in
 * this tiny client island preserves the one-tap filtering behaviour.
 */
export function AdminFilterSelect(props: SelectProps) {
  return <Select {...props} onChange={(event) => event.target.form?.requestSubmit()} />;
}
