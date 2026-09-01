'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, DownloadSimple, ShareNetwork } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { usePwaInstall } from '@/components/shared/use-pwa-install';

type InstallPlatform = 'ios' | 'android' | 'desktop' | 'other';

function detectInstallPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (window.matchMedia('(pointer: fine)').matches) return 'desktop';
  return 'other';
}

export function PwaManualInstall() {
  const t = useTranslations('PwaManual');
  const { isInstallable, install, isStandalone } = usePwaInstall();
  const [platform, setPlatform] = useState<InstallPlatform>('other');
  const [showInstructions, setShowInstructions] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const instructions = (['1', '2', '3'] as const).map((step) =>
    t(`instructions.${platform}.${step}`),
  );

  useEffect(() => setPlatform(detectInstallPlatform()), []);

  const handleInstall = async () => {
    if (!isInstallable) {
      setShowInstructions((current) => !current);
      return;
    }

    setIsInstalling(true);
    try {
      const outcome = await install();
      if (outcome !== 'accepted') setShowInstructions(true);
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
            {isStandalone
              ? t('installedDescription')
              : t('description')}
          </p>
        </div>
        {isStandalone ? (
          <span className="inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-full bg-[var(--color-primary-soft)] px-4 text-sm font-bold text-[var(--color-primary-hover)]">
            <CheckCircle size={19} weight="fill" aria-hidden="true" /> {t('installed')}
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 shrink-0 self-start"
            aria-expanded={showInstructions}
            aria-controls="manual-install-instructions"
            disabled={isInstalling}
            onClick={() => void handleInstall()}
          >
            {platform === 'ios' ? (
              <ShareNetwork size={18} aria-hidden="true" />
            ) : (
              <DownloadSimple size={18} aria-hidden="true" />
            )}
            {isInstalling ? t('installing') : isInstallable ? t('install') : t('howTo')}
          </Button>
        )}
      </div>

      {!isStandalone && showInstructions ? (
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
