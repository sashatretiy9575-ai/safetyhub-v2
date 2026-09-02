'use client';

import dynamic from 'next/dynamic';
import type { AccountMode } from '@/components/layout/navigation-items';

const BottomTabBar = dynamic(
  () => import('@/components/layout/bottom-tab-bar').then((module) => module.BottomTabBar),
  { ssr: false },
);

export function DeferredBottomTabBar({ accountMode }: { accountMode: AccountMode }) {
  return <BottomTabBar accountMode={accountMode} />;
}
