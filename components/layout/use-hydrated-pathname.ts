'use client';

import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';

const subscribeToHydration = () => () => undefined;

/**
 * Keeps route-dependent navigation markup identical during SSR and the first
 * client render. Vercel may prerender an ISR page without a request pathname,
 * while `usePathname` already contains it during hydration.
 */
export function useHydratedPathname() {
  const pathname = usePathname();
  const hasHydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );

  return hasHydrated ? pathname : null;
}
