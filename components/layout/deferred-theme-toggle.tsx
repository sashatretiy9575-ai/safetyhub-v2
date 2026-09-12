'use client';

import dynamic from 'next/dynamic';

const ThemeToggle = dynamic(
  () => import('@/components/shared/theme-toggle').then((module) => module.ThemeToggle),
  {
    ssr: false,
    // The same box the hydrated button occupies. Below 1024 px it is a square
    // icon button; above it, a labelled control of a fixed width. A placeholder
    // that only matched the square made the header jump once the chunk landed.
    loading: () => (
      <span aria-hidden="true" className="block size-11 shrink-0 lg:h-11 lg:w-[7.25rem]" />
    ),
  },
);

export function DeferredThemeToggle() {
  return <ThemeToggle />;
}
