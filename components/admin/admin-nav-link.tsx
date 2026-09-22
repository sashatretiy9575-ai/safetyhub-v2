'use client';

import type { ReactNode } from 'react';
import Link from '@/components/shared/navigation-link';
import { usePathname } from 'next/navigation';
import { DockItem } from '@/components/layout/dock-item';
import { cn } from '@/lib/utils';

export function AdminNavLink({
  href,
  label,
  shortLabel,
  children,
  mobile = false,
  spanLast = true,
}: {
  href: string;
  label: string;
  /** Shown instead of the label on the phone dock; the label stays the accessible name. */
  shortLabel?: string;
  children: ReactNode;
  mobile?: boolean;
  /** Five items: the last one takes the rest of the second row below 360 px. */
  spanLast?: boolean;
}) {
  const pathname = usePathname();
  const active =
    href === '/admin' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  // The phone dock is the public site's dock, item for item. Below 360 px five
  // captions do not fit one row, so the grid wraps to 3 + 2 and the last item
  // takes the rest of the second row; six wrap to 3 + 3 and need no filler.
  if (mobile) {
    return (
      <DockItem
        href={href}
        label={label}
        shortLabel={shortLabel}
        active={active}
        className={spanLast ? 'last:col-span-2 min-[360px]:last:col-span-1' : undefined}
      >
        {children}
      </DockItem>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm font-bold transition-colors',
        active
          ? 'bg-[var(--color-surface-muted)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
      )}
    >
      <span aria-hidden="true" className="grid shrink-0 place-items-center">
        {children}
      </span>
      <span>{label}</span>
    </Link>
  );
}
