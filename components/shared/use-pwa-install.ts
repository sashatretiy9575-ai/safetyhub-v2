'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PWA_INSTALL_EVENT_KEY, PWA_INSTALL_READY_EVENT } from '@/lib/pwa-install-bootstrap';

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type IOSNavigator = Navigator & { standalone?: boolean };

function parkedInstallPrompt(): BeforeInstallPromptEvent | null {
  const parked = (window as unknown as Record<string, unknown>)[PWA_INSTALL_EVENT_KEY];
  return parked ? (parked as BeforeInstallPromptEvent) : null;
}

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const syncStandalone = () => {
      setIsStandalone(standaloneQuery.matches || (navigator as IOSNavigator).standalone === true);
    };
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };
    // The head bootstrap may already hold an event that fired before this chunk
    // loaded; without this the banner silently never appears on a full load.
    const syncParkedPrompt = () => setDeferredPrompt(parkedInstallPrompt());

    syncStandalone();
    syncParkedPrompt();
    standaloneQuery.addEventListener('change', syncStandalone);
    window.addEventListener(PWA_INSTALL_READY_EVENT, syncParkedPrompt);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      standaloneQuery.removeEventListener('change', syncStandalone);
      window.removeEventListener(PWA_INSTALL_READY_EVENT, syncParkedPrompt);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return 'unavailable' as const;

    const prompt = deferredPrompt;
    setDeferredPrompt(null);
    (window as unknown as Record<string, unknown>)[PWA_INSTALL_EVENT_KEY] = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    return choice.outcome;
  }, [deferredPrompt]);

  return useMemo(
    () => ({
      isInstallable: deferredPrompt !== null,
      install,
      isStandalone,
    }),
    [deferredPrompt, install, isStandalone],
  );
}
