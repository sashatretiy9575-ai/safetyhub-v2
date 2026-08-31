'use client';

import Link from 'next/link';
import { PRIMARY_NAV_ITEMS } from '@/components/layout/navigation-items';
import { useHydratedPathname } from '@/components/layout/use-hydrated-pathname';
import { isRouteActive } from '@/lib/navigation';

export function HeaderNav() {
  const pathname = useHydratedPathname();

  return (
    <nav
      className="ml-3 hidden h-full items-stretch gap-0.5 min-[1120px]:flex"
      aria-label="Основная навигация"
    >
      {PRIMARY_NAV_ITEMS.map((item) => {
        const active = pathname !== null && isRouteActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={`relative inline-flex h-full min-w-11 items-center px-2.5 text-sm font-semibold transition-colors duration-150 hover:text-[var(--color-text)] ${active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
          >
            {item.label}
            {active ? (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-[var(--color-primary)]"
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
