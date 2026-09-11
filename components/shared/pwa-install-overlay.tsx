'use client';

/* eslint-disable @next/next/no-img-element */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { Export, PlusSquare, X } from '@phosphor-icons/react';
import { usePWA } from '@/components/shared/pwa-provider';
import { Button } from '@/components/ui/button';
import { detectInstallPlatform, type InstallPlatform } from '@/components/shared/install-platform';
import { splitLocalePathname } from '@/i18n/config';

// The real home-screen icon, so the banner shows what the phone will get. It
// is already a static PNG on the same origin; the image optimizer would only
// add a round trip.
const APP_ICON = '/icons/icon-192x192.png';

function routeAllowsAutomaticPrompt(pathname: string) {
  const routePathname = splitLocalePathname(pathname).pathname;
  return !(
    routePathname.startsWith('/admin') || /^\/topics\/[^/]+\/test(?:\/|$)/.test(routePathname)
  );
}

type HintIcon = typeof Export;

/** One inline "tap this" chip inside the iOS hint sentence. */
function hintChip(Icon: HintIcon) {
  const Chip = (chunks: React.ReactNode) => (
    <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap text-[var(--color-bg)]">
      <Icon size={14} weight="bold" aria-hidden="true" className="text-[var(--color-primary)]" />
      {chunks}
    </span>
  );
  return Chip;
}

/**
 * The owner wants the install card on every phone visit until the app is
 * actually installed: no delay, no once-per-session cap, no thirty-day memory
 * after a close. Closing it only hides it for the page the visitor is on.
 * Standalone (installed) launches never see it, and neither do the admin
 * screens or a running test, where it would cover the controls.
 */
export function PWAInstallOverlay() {
  const translations = useTranslations('Pwa');
  const manualTranslations = useTranslations('PwaManual');
  const pathname = usePathname();
  const { isInstallable, install, isStandalone } = usePWA();
  const [isPhone, setIsPhone] = React.useState(false);
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
    return () => query.removeEventListener('change', sync);
  }, []);

  const visible = isPhone && !isStandalone && !isDismissed && routeAllowsAutomaticPrompt(pathname);

  React.useEffect(() => {
    // The card floats 5 px above the dock, inside the bottom safe area. The
    // shell reserves its real height below the footer so nothing hides
    // underneath it.
    document.documentElement.style.setProperty(
      '--pwa-banner-space',
      visible ? 'calc(var(--mobile-tab-height) + var(--safe-area-bottom) + 10.25rem)' : '0px',
    );
    if (visible) {
      // Asked again at the moment the banner opens: the platform decides
      // whether it may offer a real install or only the manual steps.
      setPlatform(detectInstallPlatform());
    }
    return () => document.documentElement.style.setProperty('--pwa-banner-space', '0px');
  }, [visible]);

  const dismiss = React.useCallback(() => setIsDismissed(true), []);

  const handleInstall = React.useCallback(async () => {
    setIsInstalling(true);
    try {
      if (isInstallable) {
        const outcome = await install();
        if (outcome !== 'unavailable') dismiss();
      } else {
        // There is no /install route, and there never was: this sent iOS and
        // desktop Safari — the browsers with no install prompt, i.e. exactly the
        // ones that need instructions — to a 404. The steps open in place.
        setShowInstructions(true);
      }
    } finally {
      setIsInstalling(false);
    }
  }, [dismiss, install, isInstallable]);

  if (!visible) return null;

  // iOS Safari has no install prompt at all, so the banner never pretends to
  // have one there: the sentence under the title already says where the menu
  // item is, and the buttons open the detailed steps or close the banner.
  const ios = platform === 'ios';
  const steps = (['1', '2', '3'] as const).map((step) =>
    manualTranslations(`instructions.${platform}.${step}`),
  );

  return (
    <aside
      // A rounded card 5 px above the mobile dock, same side insets and max
      // width as the tab bar. Its colours are the page's inverted: a dark card
      // on the light theme, a light card on the dark one, so it never melts
      // into the dock or the page behind it.
      className="fixed right-[max(.625rem,var(--safe-area-right))] bottom-[calc(var(--safe-area-bottom)+var(--mobile-tab-height)+5px)] left-[max(.625rem,var(--safe-area-left))] z-[60] mx-auto max-w-[32.5rem] rounded-[var(--radius-dock)] border border-[var(--color-bg)]/12 bg-[var(--color-text)] p-4 pb-3 text-[var(--color-bg)] shadow-[var(--shadow-pop)]"
      role="region"
      aria-live="polite"
      aria-labelledby="pwa-install-title"
    >
      <div className="flex items-start gap-3">
        <img
          src={APP_ICON}
          alt=""
          width={48}
          height={48}
          className="size-12 shrink-0 rounded-[14px] shadow-[var(--shadow-soft)]"
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <p id="pwa-install-title" className="font-display text-[15px] leading-tight font-bold">
            {translations('title')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-bg)]/70">
            {ios
              ? translations.rich('iosHint', {
                  share: hintChip(Export),
                  add: hintChip(PlusSquare),
                })
              : translations('description')}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="-mt-1.5 -mr-1.5 grid size-11 shrink-0 place-items-center rounded-full text-[var(--color-bg)]/70 transition-colors hover:bg-[var(--color-bg)]/10 hover:text-[var(--color-bg)]"
          aria-label={translations('dismiss')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {showInstructions ? (
        <ol
          id="pwa-install-steps"
          className="mt-3 space-y-1.5 border-t border-[var(--color-bg)]/12 pt-3 text-xs leading-relaxed text-[var(--color-bg)]/70"
        >
          {steps.map((step, index) => (
            <li key={step} className="flex gap-2.5">
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-bg)]/12 text-[10px] font-bold text-[var(--color-bg)]"
              >
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="mt-3 flex gap-2">
        {ios ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShowInstructions((current) => !current)}
              aria-expanded={showInstructions}
              aria-controls="pwa-install-steps"
              className="min-h-11 flex-1 border-[var(--color-bg)]/30 text-sm text-[var(--color-bg)] hover:bg-[var(--color-bg)]/10"
            >
              {translations('howTo')}
            </Button>
            <Button type="button" size="sm" onClick={dismiss} className="min-h-11 flex-1 text-sm">
              {translations('gotIt')}
            </Button>
          </>
        ) : showInstructions && !isInstallable ? (
          <Button type="button" size="sm" onClick={dismiss} className="min-h-11 flex-1 text-sm">
            {translations('gotIt')}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleInstall()}
              disabled={isInstalling}
              className="min-h-11 flex-1 text-sm"
            >
              {isInstalling
                ? translations('installing')
                : isInstallable
                  ? translations('install')
                  : translations('howTo')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={dismiss}
              className="min-h-11 shrink-0 text-sm text-[var(--color-bg)]/85 hover:bg-[var(--color-bg)]/10"
            >
              {translations('later')}
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}
