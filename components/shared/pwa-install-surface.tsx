'use client';

import { PWAInstallOverlay } from '@/components/shared/pwa-install-overlay';
import { PWAProvider } from '@/components/shared/pwa-provider';

export function PwaInstallSurface() {
  return (
    <PWAProvider>
      <PWAInstallOverlay />
    </PWAProvider>
  );
}
