import Link from 'next/link';
import { User } from '@phosphor-icons/react/dist/ssr/User';
import { headerTooltipClass } from '@/components/layout/header-tooltip';

/**
 * The account slot of the header: a round, avatar-sized control, so that a
 * signed-in visitor's avatar menu lands in exactly the same spot the guest
 * icon occupied. It is a plain link usable from the server-rendered header and
 * from the client-only public control alike. The text label lives in
 * `aria-label` and in the pointer tooltip; the tooltip stays off below 1024 px,
 * where a tap navigates before it could be read.
 */
export function AccountIconLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={label}
      className="group relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--color-text)] transition-[color,background-color] duration-150 hover:bg-[var(--color-surface-muted)]"
    >
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-full border border-[var(--color-border-strong)]"
      >
        <User size={18} weight="regular" />
      </span>
      <span aria-hidden="true" className={`${headerTooltipClass} hidden min-[1024px]:block`}>
        {label}
      </span>
    </Link>
  );
}
