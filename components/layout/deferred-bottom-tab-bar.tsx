'use client';

import dynamic from 'next/dynamic';
import type { AccountMode } from '@/components/layout/navigation-items';

/**
 * The mobile dock stays code-split, but it is rendered on the server.
 *
 * It used to be loaded with `ssr: false` behind an empty `aria-hidden` box, so
 * below 1024 px — where the desktop navigation is hidden and this is the only
 * replacement — the delivered HTML contained no navigation at all. Dropping the
 * flag puts the five links in the document without moving the chunk into the
 * initial bundle.
 */
const BottomTabBar = dynamic(
  () => import('@/components/layout/bottom-tab-bar').then((module) => module.BottomTabBar),
  {
    loading: () => (
      <div
        aria-hidden="true"
        className="glass-strong fixed right-[max(.625rem,var(--safe-area-right))] bottom-[var(--safe-area-bottom)] left-[max(.625rem,var(--safe-area-left))] z-50 mx-auto h-[var(--mobile-tab-height)] max-w-[32.5rem] rounded-[var(--radius-dock)] p-0.5 min-[1024px]:hidden"
      />
    ),
  },
);

export function DeferredBottomTabBar({ accountMode }: { accountMode: AccountMode }) {
  return <BottomTabBar accountMode={accountMode} />;
}
