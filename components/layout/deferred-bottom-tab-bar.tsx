'use client';

import dynamic from 'next/dynamic';
import type { AccountMode } from '@/components/layout/navigation-items';

const BottomTabBar = dynamic(
  () => import('@/components/layout/bottom-tab-bar').then((module) => module.BottomTabBar),
  {
    ssr: false,
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
