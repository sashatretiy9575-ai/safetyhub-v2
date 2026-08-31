'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { usePwaInstall } from '@/components/shared/use-pwa-install';

interface PWAContextType {
  isInstallable: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  isStandalone: boolean;
}

const PWAContext = createContext<PWAContextType | undefined>(undefined);

export function PWAProvider({ children }: { children: ReactNode }) {
  const contextValue = usePwaInstall();

  return <PWAContext.Provider value={contextValue}>{children}</PWAContext.Provider>;
}

export const usePWA = () => {
  const context = useContext(PWAContext);
  if (!context) throw new Error('usePWA must be used within a PWAProvider');
  return context;
};
