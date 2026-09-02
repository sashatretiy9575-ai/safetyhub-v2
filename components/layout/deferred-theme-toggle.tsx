'use client';

import dynamic from 'next/dynamic';

const ThemeToggle = dynamic(
  () => import('@/components/shared/theme-toggle').then((module) => module.ThemeToggle),
  {
    ssr: false,
    loading: () => <span aria-hidden="true" className="block size-11 shrink-0" />,
  },
);

export function DeferredThemeToggle() {
  return <ThemeToggle />;
}
