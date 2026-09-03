'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { DownloadSimple, X } from '@phosphor-icons/react';
import { usePWA } from '@/components/shared/pwa-provider';
import { Button } from '@/components/ui/button';
import { splitLocalePathname } from '@/i18n/config';

const DISMISSAL_KEY = 'safetyhub:pwa-install-dismissal:v2';
const SESSION_KEY = 'safetyhub:pwa-install-shown:v1';
const DISMISSAL_DURATION = 30 * 24 * 60 * 60 * 1_000;
const PROMPT_DELAY_MS = 15_000;

function hasActiveDismissal() {
  try {
    const until = Number(window.localStorage.getItem(DISMISSAL_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function saveDismissal() {
  try {
    window.localStorage.setItem(DISMISSAL_KEY, String(Date.now() + DISMISSAL_DURATION));
  } catch {
    // The compact banner still closes if storage is unavailable.
  }
}

function alreadyShownThisSession() {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markShownThisSession() {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // Session limiting is best effort in privacy-restricted browsers.
  }
}

function routeAllowsAutomaticPrompt(pathname: string) {
  const routePathname = splitLocalePathname(pathname).pathname;
  return !(
    routePathname.startsWith('/admin') ||
    routePathname.startsWith('/auth') ||
    routePathname.startsWith('/onboarding') ||
    routePathname.startsWith('/profile') ||
    routePathname.startsWith('/install') ||
    /^\/topics\/[^/]+\/test(?:\/|$)/.test(routePathname)
  );
}

export function PWAInstallOverlay() {
  const translations = useTranslations('Pwa');
  const pathname = usePathname();
  const { isInstallable, install, isStandalone } = usePWA();
  const [isPhone, setIsPhone] = React.useState(false);
  const [delayElapsed, setDelayElapsed] = React.useState(false);
  const [hasInteracted, setHasInteracted] = React.useState(false);
  const [isDismissed, setIsDismissed] = React.useState(true);
  const [isInstalling, setIsInstalling] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia('(max-width: 767px) and (pointer: coarse)');
    const sync = () => setIsPhone(query.matches);
    sync();
    query.addEventListener('change', sync);
    // These three were previously forced open, which silently disabled the
    // 30-day dismissal, the once-per-session cap and the 15-second delay: the
    // banner came back immediately after every dismissal and on every reload.
    setIsDismissed(hasActiveDismissal() || alreadyShownThisSession());

    const timer = window.setTimeout(() => setDelayElapsed(true), PROMPT_DELAY_MS);
    const interact = () => setHasInteracted(true);
    window.addEventListener('pointerdown', interact, { once: true, passive: true });
    window.addEventListener('keydown', interact, { once: true });
    window.addEventListener('scroll', interact, { once: true, passive: true });
    return () => {
      query.removeEventListener('change', sync);
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', interact);
      window.removeEventListener('keydown', interact);
      window.removeEventListener('scroll', interact);
    };
  }, []);

  const visible =
    isPhone &&
    isInstallable &&
    !isStandalone &&
    !isDismissed &&
    delayElapsed &&
    hasInteracted &&
    routeAllowsAutomaticPrompt(pathname);

  React.useEffect(() => {
    document.documentElement.style.setProperty('--pwa-banner-space', visible ? '160px' : '0px');
    if (visible) markShownThisSession();
    return () => document.documentElement.style.setProperty('--pwa-banner-space', '0px');
  }, [visible]);

  const dismiss = React.useCallback(() => {
    saveDismissal();
    setIsDismissed(true);
  }, []);

  const handleInstall = React.useCallback(async () => {
    setIsInstalling(true);
    try {
      const outcome = await install();
      if (outcome !== 'unavailable') dismiss();
    } finally {
      setIsInstalling(false);
    }
  }, [dismiss, install]);

  if (!visible) return null;

  return (
    <aside
      // Sits directly on top of the mobile dock instead of floating 24px above
      // it: same side insets and same max width as the tab bar, so the two read
      // as one block rather than two unrelated cards.
      className="fixed right-[max(.625rem,var(--safe-area-right))] bottom-[calc(var(--safe-area-bottom)+var(--mobile-tab-height))] left-[max(.625rem,var(--safe-area-left))] z-[60] mx-auto flex min-h-[140px] max-w-[32.5rem] flex-col justify-between rounded-t-2xl border border-b-0 border-[var(--color-border-strong)] bg-[var(--color-surface-elevated)] p-4 text-[var(--color-text)] shadow-[var(--shadow-pop)]"
      role="region"
      aria-live="polite"
      aria-labelledby="pwa-install-title"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <DownloadSimple size={24} weight="bold" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p id="pwa-install-title" className="text-base font-black leading-tight">
            {translations('title')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            {translations('description')}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
          aria-label={translations('dismiss')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          onClick={() => void handleInstall()}
          disabled={isInstalling}
          className="min-h-11 flex-1 text-sm font-bold"
        >
          {isInstalling ? translations('installing') : translations('install')}
        </Button>
      </div>
    </aside>
  );
}
