'use client';

import type { ReactNode } from 'react';
import Link from '@/components/shared/navigation-link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export function AdminNavLink({
  href,
  label,
  shortLabel,
  children,
  mobile = false,
}: {
  href: string;
  label: string;
  /** Shown instead of the label on the phone dock; the label stays the accessible name. */
  shortLabel?: string;
  children: ReactNode;
  mobile?: boolean;
}) {
  const pathname = usePathname();
  const active =
    href === '/admin' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex min-h-11 items-center gap-3 rounded-xl font-bold transition-colors',
        active
          ? 'bg-[var(--color-surface-muted)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
        mobile
          ? 'xs:last:col-span-1 w-full min-w-0 flex-col justify-center gap-0.5 px-0.5 py-1 text-sm leading-tight last:col-span-2'
          : 'px-3 py-2 text-sm',
      )}
    >
      <span aria-hidden="true" className={cn('grid shrink-0 place-items-center', mobile && 'h-6')}>
        {children}
      </span>
      {mobile && shortLabel ? (
        <>
          <span
            aria-hidden="true"
            className="w-full text-center [overflow-wrap:anywhere] whitespace-normal"
          >
            {shortLabel}
          </span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        <span
          className={cn(mobile && 'w-full text-center [overflow-wrap:anywhere] whitespace-normal')}
        >
          {label}
        </span>
      )}
    </Link>
  );
}
