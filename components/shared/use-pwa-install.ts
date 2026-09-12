'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PWA_INSTALL_EVENT_KEY, PWA_INSTALL_READY_EVENT } from '@/lib/pwa/install-bootstrap';

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type InstallAwareNavigator = Navigator & {
  standalone?: boolean;
  getInstalledRelatedApps?: () => Promise<Array<{ platform: string; url?: string; id?: string }>>;
};

/** Remembered after `appinstalled`, so a browser tab on the same phone stops offering the app. */
const INSTALLED_STORAGE_KEY = 'safetyhub:pwa-installed';

// An installed app opens in one of these; an ordinary browser tab reports `browser`.
const INSTALLED_DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];

function parkedInstallPrompt(): BeforeInstallPromptEvent | null {
  const parked = (window as unknown as Record<string, unknown>)[PWA_INSTALL_EVENT_KEY];
  return parked ? (parked as BeforeInstallPromptEvent) : null;
}

function readRememberedInstall() {
  try {
    return window.localStorage.getItem(INSTALLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRememberedInstall(installed: boolean) {
  try {
    if (installed) window.localStorage.setItem(INSTALLED_STORAGE_KEY, '1');
    else window.localStorage.removeItem(INSTALLED_STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the browser's own signals still apply.
  }
}

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [rememberedInstall, setRememberedInstall] = useState(false);
  const [relatedAppInstalled, setRelatedAppInstalled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const displayQueries = INSTALLED_DISPLAY_MODES.map((mode) =>
      window.matchMedia(`(display-mode: ${mode})`),
    );
    // The app window itself: any installed display mode, the iOS home-screen
    // flag, or a Trusted Web Activity launched from the Android shell.
    const syncStandalone = () => {
      setIsStandalone(
        displayQueries.some((query) => query.matches) ||
          (navigator as InstallAwareNavigator).standalone === true ||
          document.referrer.startsWith('android-app://'),
      );
    };
    const acceptPrompt = (prompt: BeforeInstallPromptEvent | null) => {
      setDeferredPrompt(prompt);
      // A browser offers installation only while the app is not installed, so a
      // fresh offer means a remembered install is stale: the app was removed.
      if (prompt) {
        writeRememberedInstall(false);
        setRememberedInstall(false);
      }
    };
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      acceptPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      writeRememberedInstall(true);
      setRememberedInstall(true);
    };
    // The head bootstrap may already hold an event that fired before this chunk
    // loaded; without this the banner silently never appears on a full load.
    const syncParkedPrompt = () => acceptPrompt(parkedInstallPrompt());

    syncStandalone();
    setRememberedInstall(readRememberedInstall());
    syncParkedPrompt();
    // A browser tab asks whether the app is already on this phone. It answers
    // for the manifests listed in `related_applications`.
    const installAwareNavigator = navigator as InstallAwareNavigator;
    if (typeof installAwareNavigator.getInstalledRelatedApps === 'function') {
      installAwareNavigator
        .getInstalledRelatedApps()
        .then((apps) => {
          if (!cancelled) setRelatedAppInstalled(apps.some((app) => app.platform === 'webapp'));
        })
        .catch(() => undefined);
    }
    for (const query of displayQueries) query.addEventListener('change', syncStandalone);
    window.addEventListener(PWA_INSTALL_READY_EVENT, syncParkedPrompt);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      cancelled = true;
      for (const query of displayQueries) query.removeEventListener('change', syncStandalone);
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

  const isInstalled =
    isStandalone || relatedAppInstalled || (rememberedInstall && deferredPrompt === null);

  return useMemo(
    () => ({
      isInstallable: deferredPrompt !== null,
      install,
      isStandalone,
      isInstalled,
    }),
    [deferredPrompt, install, isInstalled, isStandalone],
  );
}
