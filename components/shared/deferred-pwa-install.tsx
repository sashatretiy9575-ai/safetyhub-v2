'use client';

import dynamic from 'next/dynamic';

const PwaInstallSurface = dynamic(
  () => import('@/components/shared/pwa-install-surface').then((module) => module.PwaInstallSurface),
  { ssr: false },
);

/** The install prompt is intentionally not part of the LCP/initial JS path. */
export function DeferredPwaInstall() {
  return <PwaInstallSurface />;
}
