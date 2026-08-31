'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type IOSNavigator = Navigator & { standalone?: boolean };

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

    syncStandalone();
    standaloneQuery.addEventListener('change', syncStandalone);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      standaloneQuery.removeEventListener('change', syncStandalone);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return 'unavailable' as const;

    const prompt = deferredPrompt;
    setDeferredPrompt(null);
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
