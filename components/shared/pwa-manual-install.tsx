'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, DownloadSimple, ShareNetwork } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { usePWA } from '@/components/shared/pwa-provider';
import { detectInstallPlatform, type InstallPlatform } from '@/components/shared/install-platform';

/**
 * The install section of the account pages. iPhone has no install sheet, so it
 * gets the steps. Every other browser gets one button while it offers
 * installation and no button while it does not: Android installs from the
 * browser's own sheet, and the menu steps once shown there were wrong.
 */
export function PwaManualInstall() {
  const t = useTranslations('PwaManual');
  const { isInstallable, install, isInstalled } = usePWA();
  const [platform, setPlatform] = useState<InstallPlatform>('other');
  const [showInstructions, setShowInstructions] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const ios = platform === 'ios';
  const instructions = (['1', '2', '3'] as const).map((step) => t(`instructions.ios.${step}`));

  useEffect(() => setPlatform(detectInstallPlatform()), []);

  const handleInstall = async () => {
    if (ios) {
      setShowInstructions((current) => !current);
      return;
    }
    setIsInstalling(true);
    try {
      await install();
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <section
      id="install-app"
      className="scroll-mt-24 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/55 p-4"
      aria-labelledby="install-app-title"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 id="install-app-title" className="font-display font-bold">
            {t('title')}
          </h3>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {isInstalled ? t('installedDescription') : t('description')}
          </p>
        </div>
        {isInstalled ? (
          <span className="inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-full bg-[var(--color-primary-soft)] px-4 text-sm font-bold text-[var(--color-primary-hover)]">
            <CheckCircle size={19} weight="fill" aria-hidden="true" /> {t('installed')}
          </span>
        ) : ios || isInstallable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 shrink-0 self-start"
            aria-expanded={ios ? showInstructions : undefined}
            aria-controls={ios ? 'manual-install-instructions' : undefined}
            disabled={isInstalling}
            onClick={() => void handleInstall()}
          >
            {ios ? (
              <ShareNetwork size={18} aria-hidden="true" />
            ) : (
              <DownloadSimple size={18} aria-hidden="true" />
            )}
            {isInstalling ? t('installing') : ios ? t('howTo') : t('install')}
          </Button>
        ) : null}
      </div>

      {ios && !isInstalled && showInstructions ? (
        <ol
          id="manual-install-instructions"
          className="mt-4 list-decimal space-y-2 border-t border-[var(--color-border)] pt-4 pl-5 text-sm text-[var(--color-text-muted)]"
        >
          {instructions.map((instruction) => (
            <li key={instruction} className="pl-1">
              {instruction}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
