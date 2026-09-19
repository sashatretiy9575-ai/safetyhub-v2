import type { ReactNode } from 'react';
import Link from '@/components/shared/navigation-link';
import { cn } from '@/lib/utils';

/**
 * One destination of a phone dock. The public tab bar and the admin dock render
 * the same item, so the two navigations cannot drift apart again: the admin one
 * had grown its own sizes, weights and active state.
 *
 * The current page is marked three ways at once — surface tint, text colour and
 * the dot — plus `aria-current`, so the dot is never the only cue.
 */
export function DockItem({
  href,
  label,
  shortLabel,
  active,
  className,
  children,
}: {
  href: string;
  label: string;
  /** Shown instead of the label where five captions do not fit; the label stays the accessible name. */
  shortLabel?: string;
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group text-micro relative flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[18px] px-0 py-1 leading-none font-semibold tracking-normal transition-[color,background-color] duration-150',
        active
          ? 'bg-[var(--color-surface-muted)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
        className,
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute top-1 size-1 rounded-full bg-[var(--color-primary)]"
        />
      ) : null}
      <span aria-hidden="true" className="flex h-7 items-center justify-center">
        {children}
      </span>
      {shortLabel ? (
        <>
          <span aria-hidden="true" className="max-w-full truncate px-0 text-center leading-tight">
            {shortLabel}
          </span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        <span className="max-w-full truncate px-0 text-center leading-tight">{label}</span>
      )}
    </Link>
  );
}
