'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DotsThreeOutline } from '@phosphor-icons/react/dist/csr/DotsThreeOutline';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type MoreItem = { href: string; label: string };

/**
 * Six equal cells left roughly 55px each on a 360px phone, so every caption was
 * clipped. The four operational sections keep their own tab; the rest move here.
 */
export function AdminMoreMenu({ items }: { items: readonly MoreItem[] }) {
  const pathname = usePathname();
  const active = items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Ещё разделы"
          aria-current={active ? 'page' : undefined}
          className={cn(
            'group flex min-h-11 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1 text-[11px] leading-none font-bold transition-colors',
            active
              ? 'bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
          )}
        >
          <span aria-hidden="true" className="grid h-6 shrink-0 place-items-center">
            <DotsThreeOutline size={20} weight={active ? 'fill' : 'regular'} />
          </span>
          <span className="max-w-20 truncate">Ещё</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-44">
        {items.map((item) => (
          <DropdownMenuItem key={item.href} asChild>
            <Link href={item.href}>{item.label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
