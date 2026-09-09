'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { DownloadSimple, X } from '@phosphor-icons/react';
import { usePWA } from '@/components/shared/pwa-provider';
import { Button } from '@/components/ui/button';
import { detectInstallPlatform, type InstallPlatform } from '@/components/shared/install-platform';
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
    routePathname.startsWith('/admin') || /^\/topics\/[^/]+\/test(?:\/|$)/.test(routePathname)
  );
}

export function PWAInstallOverlay() {
  const translations = useTranslations('Pwa');
  const manualTranslations = useTranslations('PwaManual');
  const pathname = usePathname();
  const { isInstallable, install, isStandalone } = usePWA();
  const [isPhone, setIsPhone] = React.useState(false);
  // Both start false. Initialised to `true` they made the timer below and the
  // three input listeners dead code, and the banner appeared during hydration —
  // a 160 px shift with no user input, which counts in full against CLS.
  const [delayElapsed, setDelayElapsed] = React.useState(false);
  const [hasInteracted, setHasInteracted] = React.useState(false);
  const [isDismissed, setIsDismissed] = React.useState(false);
  const [isInstalling, setIsInstalling] = React.useState(false);
  // Browsers with no install prompt — iOS Safari above all — need the manual
  // steps here, rather than at a route that does not exist.
  const [showInstructions, setShowInstructions] = React.useState(false);
  const [platform, setPlatform] = React.useState<InstallPlatform>('other');

  React.useEffect(() => {
    // Matches the range where the mobile dock exists, and only on touch
    // displays. The previous query stopped at 899 px and never asked about the
    // pointer, so between 900 and 1023 px the banner was absent while the dock
    // it sits on was present, and a narrow desktop window got a phone prompt.
    const query = window.matchMedia('(max-width: 1023px) and (pointer: coarse)');
    const sync = () => setIsPhone(query.matches);
    sync();
    query.addEventListener('change', sync);
    setPlatform(detectInstallPlatform());
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
    // A redundant disjunction on `isInstallable` used to stand here; the
    // `!isStandalone` below absorbs it, so it decided nothing.
    !isStandalone &&
    !isDismissed &&
    delayElapsed &&
    hasInteracted &&
    routeAllowsAutomaticPrompt(pathname);

  React.useEffect(() => {
    // The banner is at least 140 px tall and sits on top of the dock, inside the
    // bottom safe area. Reserving a flat 160 px on <main> left it covering the
    // footer; the shell now reserves the real height around everything.
    document.documentElement.style.setProperty(
      '--pwa-banner-space',
      visible ? 'calc(var(--mobile-tab-height) + var(--safe-area-bottom) + 10.25rem)' : '0px',
    );
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
      if (isInstallable) {
        const outcome = await install();
        if (outcome !== 'unavailable') dismiss();
      } else {
        // There is no /install route, and there never was: this sent iOS and
        // desktop Safari — the browsers with no install prompt, i.e. exactly the
        // ones that need instructions — to a 404. The account page carries the
        // manual instructions.
        setShowInstructions(true);
      }
    } finally {
      setIsInstalling(false);
    }
  }, [dismiss, install, isInstallable]);

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
          <p id="pwa-install-title" className="text-base leading-tight font-black">
            {translations('title')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            {translations('description')}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="grid size-11 shrink-0 place-items-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
          aria-label={translations('dismiss')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {showInstructions ? (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {(['1', '2', '3'] as const).map((step) => (
            <li key={step}>{manualTranslations(`instructions.${platform}.${step}`)}</li>
          ))}
        </ol>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          onClick={() => void handleInstall()}
          disabled={isInstalling || showInstructions}
          className="min-h-11 flex-1 text-sm font-bold"
        >
          {isInstalling
            ? translations('installing')
            : showInstructions
              ? manualTranslations('howTo')
              : translations('install')}
        </Button>
      </div>
    </aside>
  );
}
