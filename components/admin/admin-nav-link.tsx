'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export function AdminNavLink({
  href,
  label,
  children,
  mobile = false,
}: {
  href: string;
  label: string;
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
          ? 'bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
        mobile
          ? 'min-w-0 w-full flex-col justify-center gap-0.5 px-1 py-1.5 text-[10px] leading-none'
          : 'px-3 py-2 text-sm',
      )}
    >
      <span aria-hidden="true" className={cn('grid shrink-0 place-items-center', mobile && 'h-6')}>
        {children}
      </span>
      <span className={cn(mobile && 'max-w-20 truncate')}>{label}</span>
    </Link>
  );
}
